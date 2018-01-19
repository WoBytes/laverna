/**
 * @module components/importExport/Import
 */
import Mn from 'backbone.marionette';
import _ from 'underscore';
import Radio from 'backbone.radio';
import JSZip from 'jszip';

import deb from 'debug';

const log = deb('lav:components/importExport/Import');

/**
 * Import data to Laverna from a ZIP archive.
 *
 * @class
 * @extends Marionette.Object
 * @license MPL-2.0
 */
export default class Import extends Mn.Object {

    /**
     * Radio channel (components/importExport).
     *
     * @prop {Object}
     */
    get channel() {
        return Radio.channel('components/importExport');
    }

    init() { // eslint-disable-line complexity
        if (this.options.files && this.options.files.length) {
            if (this.isZipFile()) {
                return this.importData();
            }
            else if (this.isKey()) {
                return this.importKey();
            }
        }

        // Do nothing if there aren't any ZIP archives
        return Promise.resolve();
    }

    /**
     * If import is successful, trigger "completed" and reload the page after 800ms.
     */
    onSuccess() {
        this.channel.trigger('completed');
        window.setTimeout(() => document.location.reload(), 800);
    }

    /**
     * If import failed, trigger "completed" event with the error.
     *
     * @param {String} error
     */
    onError(error) {
        log('error', error);
        this.channel.trigger('completed', {error});
    }

    /**
     * Check if a file is a ZIP archive.
     *
     * @param {Object} file=this.options.files[0]
     * @param {String} file.type
     * @param {String} file.name
     * @returns {Boolean}
     */
    isZipFile(file = this.options.files[0]) {
        return (
            file.type === 'application/zip' ||
            _.last(file.name.split('.')) === 'zip'
        );
    }

    /**
     * Check if a file is a private key.
     *
     * @param {Object} file=this.options.files[0]
     * @param {String} file.type
     * @param {String} file.name
     * @param {String} file.size
     * @returns {Boolean}
     */
    isKey(file = this.options.files[0]) {
        return (
            file.type === 'text/plain' &&
            _.last(file.name.split('.')) === 'asc' &&
            file.size >= 2500
        );
    }

    /**
     * Import everything from a ZIP file.
     *
     * @returns {Promise}
     */
    importData() {
        // Trigger an event that import proccess started
        this.channel.trigger('started');

        return this.readZip(this.options.files[0])
        .then(zip  => this.import(zip))
        .then(()   => this.onSuccess())
        .catch(err => this.onError(err));
    }

    /**
     * Import a private key.
     *
     * @returns {Promise}
     */
    importKey() {
        // Trigger an event that import proccess started
        this.channel.trigger('started');

        return this.readText(this.options.files[0])
        .then(value => {
            return Radio.request('collections/Configs', 'saveConfig', {
                config: {value, name: 'privateKey'},
            });
        })
        .then(()   => this.onSuccess())
        .catch(err => this.onError(err));
    }

    /**
     * Read a text file.
     *
     * @param {Object} file
     * @returns {Promise} resolves with string
     */
    readText(file) {
        return new Promise(resolve => {
            const reader  = new FileReader();
            reader.onload = (e => resolve(e.target.result));
            reader.readAsText(file);
        });
    }

    /**
     * Read a ZIP archive.
     *
     * @param {Object} file
     * @returns {Promise} resolves with JSZip instance
     */
    readZip(file) {
        const reader = new FileReader();
        this.zip     = new JSZip();

        return new Promise((resolve, reject) => {
            reader.onload = evt => {
                this.zip.loadAsync(evt.target.result)
                .then(() => resolve(this.zip))
                .catch(err => reject(err));
            };

            reader.readAsArrayBuffer(file);
        });
    }

    /**
     * Import files from a ZIP archive.
     *
     * @param {Object} zip
     * @returns {Promise}
     */
    import(zip) {
        const promises = [];
        let configFile;

        _.each(zip.files, file => {
            // Ignore directories and non JSON files
            if (file.dir || _.last(file.name.split('.')) !== 'json') {
                return;
            }

            if (file.name.indexOf('configs.json') === -1) {
                promises.push(this.readFile(zip, file));
            }
            else {
                configFile = file;
            }
        });

        // Import configs at the end to avoid encryption errors
        return Promise.all(promises)
        .then(() => this.readFile(zip, configFile));
    }

    /**
     * Read a file from the ZIP archive.
     *
     * @param {Object} zip
     * @param {Object} file
     * @returns {Promise}
     */
    readFile(zip, file) {
        return zip.file(file.name).async('string')
        .then(res => {
            const path      = file.name.split('/');
            const profileId = path[1] === 'notes-db' ? 'default' : path[1];
            const data      = JSON.parse(res);

            if (path[2] === 'notes') {
                return this.importNote({zip, profileId, data, name: file.name});
            }
            else if (path[2] === 'files') {
                return this.importFile({profileId, data});
            }
            else {
                const type = path[2].split('.json')[0];
                return this.importCollection({profileId, data, type});
            }
        });
    }

    /**
     * Import a note to database.
     *
     * @param {Object} options
     * @param {Object} options.zip - JSZip instance
     * @param {String} options.name - file name of a note
     * @param {String} options.profileId
     * @param {Object} options.data
     * @returns {Promise}
     */
    importNote(options) {
        const {data, profileId} = options;

        return this.readMarkdown(options)
        .then(() => {
            return Radio.request('collections/Notes', 'saveModelObject', {
                data,
                profileId,
                dontValidate: true,
            });
        });
    }

    /**
     * Read a note's content from Markdown file.
     *
     * @param {Object} data
     * @param {String} name
     * @param {Object} zip
     * @returns {Promise}
     */
    readMarkdown({data, name, zip}) {
        if (data.encryptedData && data.encryptedData.length) {
            return Promise.resolve();
        }

        const mdName = name.replace(/\.json$/, '.md');
        return zip.file(mdName).async('string')
        // eslint-disable-next-line
        .then(content => data.content = content);
    }

    /**
     * Import a file attachment to database.
     *
     * @param {Object} options
     * @param {String} options.profileId
     * @param {Object} options.data
     * @returns {Promise}
     */
    importFile(options) {
        const {data, profileId} = options;
        return Radio.request('collections/Files', 'saveModelObject', {
            data,
            profileId,
        });
    }

    /**
     * Import a collection to database.
     *
     * @param {Object} options
     * @param {String} options.type - collection name (notebooks, tags, configs...)
     * @param {String} options.profileId
     * @param {Object} options.data
     * @returns {Promise}
     */
    importCollection(options) {
        // Do nothing if the collection name is incorrect
        const types = ['notebooks', 'tags', 'configs', 'users', 'files'];
        if (_.indexOf(types, options.type) === -1) {
            return Promise.resolve();
        }

        const type = _.capitalize(options.type);

        return Radio.request(`collections/${type}`, 'saveFromArray', {
            profileId : options.profileId,
            values    : options.data,
        });
    }

}