import Dexie from 'dexie'
import 'dexie-mongoify'

import { StorageRegistry } from 'storex/ts'
// import { CollectionDefinition } from 'storex/types'
import * as backend from 'storex/ts/types/backend'
import { augmentCreateObject } from 'storex/ts/backend/utils'
import { getDexieHistory, getTermsIndex } from './schema'
import { DexieMongoify } from './types'
import { IndexDefinition, CollectionField, CollectionDefinition, isChildOfRelationship, isConnectsRelationship } from 'storex/ts/types';
import { StorageBackendFeatureSupport } from 'storex/ts/types/backend-features';

export interface IndexedDbImplementation {
    factory : IDBFactory
    range : new () => IDBKeyRange
}

export type Stemmer = (text : string) => Promise<Set<string>>

export class DexieStorageBackend extends backend.StorageBackend {
    protected features : StorageBackendFeatureSupport = {
        count: true,
        createWithRelationships: true,
        fullTextSearch: true,
        relationshipFetching: true,
    }

    private dbName : string
    private idbImplementation : IndexedDbImplementation
    private dexie : DexieMongoify
    private stemmer = null

    constructor(
        {dbName, idbImplementation = null, stemmer = null} :
        {dbName : string, idbImplementation? : IndexedDbImplementation, stemmer? : Stemmer}
    ) {
        super()

        this.dbName = dbName
        this.idbImplementation = idbImplementation || {factory: window.indexedDB, range: window['IDBKeyRange']}
        this.stemmer = stemmer
    }

    configure({registry} : {registry : StorageRegistry}) {
        super.configure({registry})
        registry.once('initialized', this._onRegistryInitialized)

        const origCreateObject = this.createObject.bind(this)
        this.createObject = augmentCreateObject(origCreateObject, { registry })
    }

    supports(feature : string) {
        if (feature !== 'fullTextSearch') {
            return super.supports(feature)
        }

        return !!this.stemmer
    }

    _onRegistryInitialized = () => {
        this._validateRegistry()
        this._initDexie()
    }

    _validateRegistry() {
        if (this.stemmer) {
            return
        }

        // See if we're trying to create full-text indices without providing a stemmer
        for (const [collectionName, collectionDefinition] of Object.entries(this.registry.collections)) {
            for (const index of collectionDefinition.indices) {
                if (typeof index === 'string') {
                    const field = collectionDefinition.fields[index]
                    if (field.type === 'text') {
                        throw new Error(
                            `Trying to create full-text index on '${collectionName}.${index}'
                            without having supplied a stemmer to the Dexie back-end`
                        )
                    }
                }
            }
        }
    }

    _initDexie = () => {
        this.dexie = new Dexie(this.dbName, {
            indexedDB: this.idbImplementation.factory,
            IDBKeyRange: this.idbImplementation.range
        }) as DexieMongoify

        const dexieHistory = getDexieHistory(this.registry)
        dexieHistory.forEach(({ version, schema }) => {
            this.dexie.version(version)
                .stores(schema)
                // .upgrade(() => {
                //     migrations.forEach(migration => {
                //         // TODO: Call migration with some object that allows for data manipulation
                //     })
                // })
        })
    }

    async migrate({database} : {database? : string} = {}) {
        if (database) {
            throw new Error('This backend doesn\'t support multiple databases directly')
        }
    }

    async cleanup() : Promise<any> {

    }

    async createObject(collection : string, object, options : backend.CreateSingleOptions & {_transaction?} = {}) : Promise<backend.CreateSingleResult> {
        const collectionDefinition = this.registry.collections[collection]
        await _processFieldsForWrites(collectionDefinition, object, this.stemmer)
        await this.dexie.table(collection).put(object)
        
        return {object}
    }
    
    async findObjects<T>(collection : string, query, findOpts : backend.FindManyOptions = {}) : Promise<Array<T>> {
        let coll = this.dexie.collection(collection).find(query)

        if (findOpts.reverse) {
            coll = coll.reverse()
        }

        if (findOpts.skip && findOpts.skip > 0) {
            coll = coll.offset(findOpts.skip)
        }

        if (findOpts.limit) {
            coll = coll.limit(findOpts.limit)
        }

        const docs = await coll.toArray()
        if (findOpts.relationships) {
            console.log('fetching relationships', findOpts.relationships)
            const collectionDefinition = this.registry.collections[collection]
            const pkField = collectionDefinition.pkIndex as string
            for (const doc of docs) {
                const pk = doc[pkField]
                Object.assign(doc, await this._fetchRelatedObjects(collection, pk, findOpts.relationships))
            }
            console.log('fetched relationships')
        }

        return docs as T[]
    }
    
    async updateObjects(collection : string, query, updates, options : backend.UpdateManyOptions & {_transaction?} = {}) : Promise<backend.UpdateManyResult> {
        const { modifiedCount } = await this.dexie
            .collection(collection)
            .update(query, updates)

        // return modifiedCount
    }
    
    async deleteObjects(collection : string, query, options : backend.DeleteManyOptions = {}) : Promise<backend.DeleteManyResult> {
        const { deletedCount } = await this.dexie
            .collection(collection)
            .remove(query)

        // return deletedCount
    }

    async count(collection : string, query) {
        return this.dexie.collection(collection).count(query)
    }

    async _fetchRelatedObjects(mainCollectionName : string, mainPk : string, relationships : backend.RelationshipFetch) {
        let relationshipsWithOptions = []
        if (Array.isArray(relationships)) {
            relationshipsWithOptions = relationships.map(aliasPath => [aliasPath, null])
        } else {
            relationshipsWithOptions = Object.entries(relationships)
        }

        const mainRelationshipAliases = []
        const relationshipAliasPathsByChild = {}
        for (const [aliasPath, relationshipOptions] of relationshipsWithOptions) {
            const aliasPathParts = aliasPath.split('.')
            if (aliasPathParts.length === 1) {
                mainRelationshipAliases.push(aliasPath)
            } else {
                const childAlias = aliasPathParts[0]
                relationshipAliasPathsByChild[childAlias] = relationshipAliasPathsByChild[childAlias] || []
                relationshipAliasPathsByChild[childAlias].push(aliasPathParts.slice(1).join('.'))
            }
        }

        console.log('mainRelationshipAliases', mainRelationshipAliases)

        const relatedObjects = {}
        const mainCollectionDefinition = this.registry.collections[mainCollectionName]
        for (const childAlias of mainRelationshipAliases) {
            const reverseRelationship = mainCollectionDefinition.reverseRelationshipsByAlias[childAlias]
            if (isChildOfRelationship(reverseRelationship)) {
                const childCollectionName = reverseRelationship.sourceCollection
                // const childCollection = this.registry.collections[childCollectionName]
                if (reverseRelationship.single) {
                    const child = await this.findObject(childCollectionName, {[reverseRelationship.alias]: mainPk})
                    relatedObjects[childAlias] = child
                } else {
                    console.log('fetch children', childCollectionName, {[reverseRelationship.alias]: mainPk})
                    const children = await this.findObjects(childCollectionName, {[reverseRelationship.alias]: mainPk})
                    relatedObjects[childAlias] = children
                }
            } else if (isConnectsRelationship(reverseRelationship)) {

            }
        }

        for (const [childAlias, paths] of Object.entries(relationshipAliasPathsByChild)) {
            const reverseRelationship = mainCollectionDefinition.reverseRelationshipsByAlias[childAlias]
            if (isChildOfRelationship(reverseRelationship)) {
                const childCollectionName = reverseRelationship.sourceCollection
                const childCollectionDefinition = this.registry.collections[childCollectionName]
                const assignRelatedObjects = async child => {
                    const childPk = child[childCollectionDefinition.pkIndex as string]
                    const childRelatedObjects = await this._fetchRelatedObjects(childCollectionName, childPk, paths)
                    Object.assign(child, childRelatedObjects)
                }

                if (reverseRelationship.single) {
                    const child = relatedObjects[childAlias]
                    await assignRelatedObjects(child)
                } else {
                    const children = relatedObjects[childAlias]
                    await Promise.all(children.map(assignRelatedObjects))
                }
            } else if (isConnectsRelationship(reverseRelationship)) {

            }
        }

        console.log('relatedObjects', relatedObjects)

        return relatedObjects
    }
}

/**
 * Handles mutation of a document to be inserted/updated to storage,
 * depending on needed pre-processing for a given indexed field.
 */
export async function _processIndexedField(
    fieldName: string,
    indexDef: IndexDefinition,
    fieldDef: CollectionField,
    object,
    stemmer : Stemmer,
) {
    switch (fieldDef.type) {
        case 'text':
            const fullTextField =
                indexDef.fullTextIndexName ||
                getTermsIndex(fieldName)
            object[fullTextField] = [...await stemmer(object[fieldName])]
            break
        default:
    }
}

/**
 * Handles mutation of a document to be written to storage,
 * depending on needed pre-processing of fields.
 */
export async function _processFieldsForWrites(def: CollectionDefinition, object, stemmer : Stemmer) {
    for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
        if (fieldDef.fieldObject) {
            object[fieldName] = await fieldDef.fieldObject.prepareForStorage(
                object[fieldName],
            )
        }

        if (fieldDef._index != null) {
            await _processIndexedField(
                fieldName,
                def.indices[fieldDef._index],
                fieldDef,
                object,
                stemmer
            )
        }
    }
}

/**
 * Handles mutation of a document to be read from storage,
 * depending on needed pre-processing of fields.
 */
export function _processFieldsForReads(def: CollectionDefinition, object) {
    Object.entries(def.fields).forEach(([fieldName, fieldDef]) => {
        if (fieldDef.fieldObject) {
            object[fieldName] = fieldDef.fieldObject.prepareFromStorage(
                object[fieldName],
            )
        }
    })
}