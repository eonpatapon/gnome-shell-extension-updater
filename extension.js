/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */
/**
    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 2 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
**/

const Main = imports.ui.main;
const Soup = imports.gi.Soup;
const Lang = imports.lang;
const Config = imports.misc.config;
const MessageTray = imports.ui.messageTray;
const St = imports.gi.St;
const Mainloop = imports.mainloop;
const ExtensionSystem = imports.ui.extensionSystem;
const FileUtils = imports.misc.fileUtils;
const Gio = imports.gi.Gio;
const Gettext = imports.gettext.domain('gnome-shell-extension-updater');
const _ = Gettext.gettext;

const REPOSITORY_URL_UPDATES = ExtensionSystem.REPOSITORY_URL_BASE + '/update-info/';
const UPDATE_INTERVAL = 432000;
const DEBUG = false;

const _httpSession = new Soup.SessionAsync();
_httpSession.timeout = 10;

if (Soup.Session.prototype.add_feature != null)
    Soup.Session.prototype.add_feature.call(_httpSession, new Soup.ProxyResolverDefault());

let extensionsUpdatesManager;
let settings;

function ExtensionsUpdatesManager() {
    this._init.apply(this, arguments);
}

ExtensionsUpdatesManager.prototype = {
    _init: function() {
        // Monitor extensions state changes
        this._stateChangedId = ExtensionSystem.connect('extension-state-changed',
                                                       Lang.bind(this, this.stateChanged));
        // Our notification source
        this.source = false;
        // Internal list of extensions
        this.list = {};
        // Extensions to update
        this.update_list = {};
        // Number of errors while updating
        this.errors = 0;
        // Load extensions that can be updated
        this.loadList();
        // Check when to start the update check
        this.getSettings();
    },

    getSettings: function() {
        let next_check = settings.get_int('lastcheck') + UPDATE_INTERVAL;
        let current_timestamp = Math.round(new Date().getTime() / 1000);
        if (next_check - current_timestamp > 0) {
            Mainloop.timeout_add_seconds((next_check - current_timestamp),
                                         Lang.bind(this, this.checkUpdates));
        }
        else 
            this.checkUpdates();
    },

    loadList: function() {
        // Load the list of extensions that can be updated
        this.list = {};
        let types;
        let extensions;
        if (ExtensionSystem.ExtensionUtils) { // 3.4
            types = ExtensionSystem.ExtensionUtils.ExtensionType;
            extensions = ExtensionSystem.ExtensionUtils.extensions;
        }
        else { // 3.2
            types = ExtensionSystem.ExtensionType;
            extensions = ExtensionSystem.extensionMeta;
        }

        for (let uuid in extensions) {
            // Get enabled extensions installed from e.g.o
            if (uuid != "updater@patapon.info" &&
                extensions[uuid].type == types.PER_USER &&
                extensions[uuid].state != ExtensionSystem.ExtensionState.DISABLED &&
                (extensions[uuid].version || 
                 (extensions[uuid].metadata && extensions[uuid].metadata.version)
                )
               ) {
                    let version;
                    let name;
                    if (extensions[uuid].metadata) { // 3.4
                        version = extensions[uuid].metadata.version;
                        name = extensions[uuid].metadata.name;
                    }
                    else { // 3.2
                        version = extensions[uuid].version;
                        name = extensions[uuid].name;
                    }
                    this.list[uuid] = {uuid: uuid,
                                       version: version,
                                       name: name,
                                       state: extensions[uuid].state}
            }
        }
    },

    checkUpdates: function() {
        let installed = {};
        for (let uuid in this.list) {
            if (DEBUG)
                this.list[uuid].version = 1;
            installed[uuid] = this.list[uuid].version;
        }
        let params = {'installed': JSON.stringify(installed),
                      'shell_version': Config.PACKAGE_VERSION};

        let message = Soup.form_request_new_from_hash('GET',
                                                      REPOSITORY_URL_UPDATES,
                                                      params);
        _log("Checking for updates.");
        _log(JSON.stringify(params));

        _httpSession.queue_message(message,
            Lang.bind(this, function(session, message) {
                this.update_list = {};

                if (message.status_code == Soup.KnownStatusCode.OK) {
                    let operations = JSON.parse(message.response_body.data);
                    for (let uuid in operations) {
                        if (operations[uuid].operation == "upgrade")
                            this.update_list[uuid] = {
                                'name': this.list[uuid].name,
                                'version_tag': operations[uuid].version_tag.toString()
                            };
                    }
                    settings.set_int('lastcheck', Math.round(new Date().getTime() / 1000))
                    Mainloop.timeout_add_seconds(UPDATE_INTERVAL, Lang.bind(this, this.checkUpdates));
                }
                else {
                    // Retry in 5 mins
                    Mainloop.timeout_add_seconds(300, Lang.bind(this, this.checkUpdates));
                }

                _log("Updates: %s".format(JSON.stringify(this.update_list)));

                if (Object.keys(this.update_list).length > 0) {
                    this.source = new ExtensionsUpdatesSource();
                    this.source.showUpdates(this.update_list);
                }

            })
        );
    },

    updateExtensions: function() {
        for (let uuid in this.update_list) {
            this.updateExtension(uuid,
                                 this.list[uuid].name,
                                 this.update_list[uuid].version_tag);
        }
    },

    updateExtension: function(uuid, name, version_tag) {
        new ExtensionUpdate(uuid, name, version_tag);
    },

    stateChanged: function(source, meta) {
        if (this.list[meta.uuid]) { // Upgrade / Uninstall
            
            let uuid = meta.uuid;
            let name = this.list[uuid].name;
            let old_state = this.list[uuid].state;
            let new_state = meta.state;
            let error = meta.error;

            _log("State of %s changed from %s to %s".format(uuid, old_state, new_state))

            if (old_state == ExtensionSystem.ExtensionState.ENABLED &&
                new_state == ExtensionSystem.ExtensionState.DOWNLOADING) {
                    this.source.showStartUpdates()
            }
            if (old_state == ExtensionSystem.ExtensionState.UNINSTALLED &&
                new_state == ExtensionSystem.ExtensionState.ENABLED) {
                    this.endUpdateSuccess(uuid, name);
            }
            if (old_state == ExtensionSystem.ExtensionState.DOWNLOADING &&
                new_state == ExtensionSystem.ExtensionState.ERROR) {
                    this.endUpdateError(uuid, name, error);
            }
            // Update to the current state
            this.list[uuid].state = new_state;
        }
        else { // New install
            // reload the list
            this.loadList();
        }
    },

    endUpdateAll: function() {
        if (Object.keys(this.update_list).length == 0) {
            if (this.errors > 0)
                this.source.showEndUpdatesErrors();
            else
                this.source.showEndUpdatesSuccess();
            this.errors = 0;
        }
    },

    endUpdateSuccess: function(uuid, name) {
        _log("%s updated".format(uuid));
        delete this.update_list[uuid];
        this.source.showUpdateDone(name);
        this.endUpdateAll();
    },

    endUpdateError: function(uuid, name, error) {
        _log("%s error : %s".format(uuid, error));
        this.errors += 1;
        this.source.showUpdateError(uuid, name, this.update_list[uuid].version_tag, error);
        delete this.update_list[uuid];
        this.endUpdateAll();
    },
}


function ExtensionUpdate() {
    this._init.apply(this, arguments);
}

ExtensionUpdate.prototype = {
    _init: function(uuid, name, version_tag) {
        this.uuid = uuid;
        this.name = name;
        this.version_tag = version_tag;
        this.download();
    },

    download: function() {
        let state = { uuid: this.uuid,
                      state: ExtensionSystem.ExtensionState.DOWNLOADING,
                      error: '' };

        ExtensionSystem._signals.emit('extension-state-changed', state);

        let params = { version_tag: this.version_tag,
                       shell_version: Config.PACKAGE_VERSION,
                       api_version: ExtensionSystem.API_VERSION.toString() };

        let url = ExtensionSystem.REPOSITORY_URL_DOWNLOAD.format(this.uuid);
        this.message = Soup.form_request_new_from_hash('GET', url, params);

        _httpSession.queue_message(this.message,
                                   Lang.bind(this, this.downloadResponse));
    },

    downloadResponse: function(session, message) {
        _log("Status code %s".format(message.status_code));
        if (message.status_code == Soup.KnownStatusCode.OK) {
            _log("OK update %s".format(this.uuid));
            this.update(session, message);
        }
        else {
            let state = { uuid: this.uuid,
                          state: ExtensionSystem.ExtensionState.ERROR,
                          error: _("Failed to download extension '%s'").format(this.name) };
            _log("Error: %s".format(JSON.stringify(state)));
            ExtensionSystem._signals.emit('extension-state-changed', state);
        }
    },

    update: function(session, message) {
        _log("Uninstall %s".format(this.uuid));
        ExtensionSystem.uninstallExtensionFromUUID(this.uuid);
        _log("Extract new version of %s".format(this.uuid));
        ExtensionSystem.gotExtensionZipFile(session, message, this.uuid);
    }
}

function ExtensionsUpdatesSource() {
    this._init.apply(this, arguments);
}

ExtensionsUpdatesSource.prototype = {
    __proto__: MessageTray.Source.prototype,

    _init: function(manager) {
        MessageTray.Source.prototype._init.call(this, _("Extensions updates"));
        this.updates_notification = false;
        this.error_notification = false;
        this.success_notification = false;
    },

    showUpdates: function(update_list) {
        let list = "";
        for (let uuid in update_list)
            list += "\n- <b>%s</b>".format(update_list[uuid].name)
        this.updates_notification = new ExtensionsUpdatesNotification(this,
            _("Extensions updates available"),
            _("Updates for the following extensions are available:") + list
        );
        this.updates_notification.setResident(true);
        this._setSummaryIcon(this.createNotificationIcon());
        Main.messageTray.add(this);
        this.notify(this.updates_notification);
    },

    showStartUpdates: function() {
        let params = {clear: true};
        this.updates_notification.update(_("Updating extensions..."), "", params);
    },

    showEndUpdatesSuccess: function() {
        let params = {clear: true};
        this.updates_notification.setResident(false);
        this.updates_notification.update(_("Extensions updated"), "", params);
    },

    showEndUpdatesErrors: function() {
        let params = {clear: true};
        this.updates_notification.setResident(true);
        this.updates_notification.update(_("Failed to update some extensions"), "", params);
    },

    showUpdateError: function(uuid, name, version_tag, error) {
        this.error_notification = new ExtensionUpdateErrorNotification(this,
            uuid, name, version_tag, error
        );
        this._setSummaryIcon(this.createNotificationErrorIcon());
        this.error_notification.setResident(true);
        this.notify(this.error_notification);
    },

    showUpdateDone: function(name) {
        this.success_notification = new ExtensionUpdateDoneNotification(this,
            _("Extension '%s' updated").format(name)
        );
        this._setSummaryIcon(this.createNotificationIcon());
        this.notify(this.success_notification);
    },

    createNotificationIcon: function() {
        return new St.Icon({icon_name: 'software-update-available',
                            icon_size: this.ICON_SIZE,
                            icon_type: St.IconType.FULLCOLOR});
    },

    createNotificationErrorIcon: function() {
        return new St.Icon({icon_name: 'dialog-warning',
                            icon_size: this.ICON_SIZE,
                            icon_type: St.IconType.FULLCOLOR});
    }
}


function ExtensionsUpdatesNotification() {
    this._init.apply(this, arguments);
}

ExtensionsUpdatesNotification.prototype = {
    __proto__: MessageTray.Notification.prototype,

    _init: function(source, title, body) {
        this.source = source;
        MessageTray.Notification.prototype._init.call(this, this.source,
                                                      title, null,
                                                      { customContent: true,
                                                        bodyMarkup: true });

        this.addBody(body, true);
        this.addButton('update', _("Update all"));
        this.addButton('ignore', _("Ignore"));

        this.connect('clicked', Lang.bind(this, function() {
            this.source.destroyNonResidentNotifications();
        }));

        this.connect('action-invoked', Lang.bind(this, function(self, action) {
            switch (action) {
                case 'update':
                    extensionsUpdatesManager.updateExtensions();
                    break;
                case 'ignore':
                    this.destroy();
            }
        }));
    }
}

function ExtensionUpdateDoneNotification() {
    this._init.apply(this, arguments);
}

ExtensionUpdateDoneNotification.prototype = {
    __proto__: MessageTray.Notification.prototype,

    _init: function(source, title) {
        this.source = source;
        MessageTray.Notification.prototype._init.call(this, this.source,
                                                      title, null, {});

        this.connect('clicked', Lang.bind(this, function() {
            this.source.destroyNonResidentNotifications();
        }));
    }
}


function ExtensionUpdateErrorNotification() {
    this._init.apply(this, arguments);
}

ExtensionUpdateErrorNotification.prototype = {
    __proto__: MessageTray.Notification.prototype,

    _init: function(source, uuid, name, version_tag, error) {
        this.source = source;
        this.uuid = uuid;
        this.name = name;
        this.version_tag = version_tag;
        MessageTray.Notification.prototype._init.call(this, this.source,
                                                      error, null, {});
        
        this.addButton('retry', _("Retry"));
        this.addButton('ignore', _("Ignore"));

        this.connect('action-invoked', Lang.bind(this, function(self, action) {
            switch (action) {
                case 'retry':
                    extensionsUpdatesManager.updateExtension(this.uuid, this.name, this.version_tag);
                    this.destroy();
                    break;
                case 'ignore':
                    this.destroy();
            }
        }));
        
        this.connect('clicked', Lang.bind(this, function() {
            this.source.destroyNonResidentNotifications();
        }));
    }
}

function init(metadata) {
    imports.gettext.bindtextdomain('gnome-shell-extension-updater', metadata.path + '/locale');
    let schemaName = "org.gnome.shell.extensions.updater";
    let schemaSource = Gio.SettingsSchemaSource.new_from_directory(metadata.path + '/schema',
                                    Gio.SettingsSchemaSource.get_default(),
                                    false);
    let schema = schemaSource.lookup(schemaName, false);
    settings = new Gio.Settings({ settings_schema: schema });
}

function enable() {
    // Wait that all extensions are loaded
    Mainloop.timeout_add_seconds(6, function() {
        // 3.4
        // Remove ourself from the extensionOrder list so that we won't get
        // disabled when another extension is disabled
        if (ExtensionSystem.extensionOrder) {
            let idx = ExtensionSystem.extensionOrder.indexOf('updater@patapon.info');
            if (idx != -1) ExtensionSystem.extensionOrder.splice(idx, 1);
        }
        extensionsUpdatesManager = new ExtensionsUpdatesManager();
    });
}

function disable() {
    if (extensionsUpdatesManager._stateChangedId)
        ExtensionSystem.disconnect(extensionsUpdatesManager._stateChangedId);
    extensionsUpdatesManager = null;
}

function _log(msg) {
    if (DEBUG)
        log(msg)
}
