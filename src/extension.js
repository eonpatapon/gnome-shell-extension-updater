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
const GLib = imports.gi.GLib;
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
            installed[uuid] = this.list[uuid];
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
                        if (operations[uuid] == "upgrade")
                            this.update_list[uuid] = {
                                'name': this.list[uuid].name,
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
        this.errors = 0;
        for (let uuid in this.update_list) {
            if (this.list[uuid])
                this.updateExtension(uuid,
                                     this.list[uuid].name);
        }
    },

    updateExtension: function(uuid, name) {
        new ExtensionUpdate(uuid, name);
    },

    stateChanged: function(source, meta) {
        if (this.list[meta.uuid]) { // Upgrade / Uninstall

            let uuid = meta.uuid;
            let name = this.list[uuid].name;
            let old_state = this.list[uuid].state;
            let new_state = meta.state;
            let error = meta.error;

            _log("State of %s changed from %s to %s".format(uuid, old_state, new_state))

            if ((old_state == ExtensionSystem.ExtensionState.ENABLED ||
                 old_state == ExtensionSystem.ExtensionState.ERROR) &&
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
        if (Object.keys(this.update_list).length == this.errors) {
            if (this.errors > 0)
                this.source.showEndUpdatesErrors();
            else
                this.source.showEndUpdatesSuccess();
            // Update done, refresh our extension list
            this.loadList();
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
        this.source.showUpdateError(error);
        this.endUpdateAll();
    },
}


function ExtensionUpdate() {
    this._init.apply(this, arguments);
}

ExtensionUpdate.prototype = {
    _init: function(uuid, name) {
        this.uuid = uuid;
        this.name = name;
        this.download();
    },

    download: function() {

        let state = { uuid: this.uuid,
                      state: ExtensionSystem.ExtensionState.DOWNLOADING,
                      error: '' };

        ExtensionSystem._signals.emit('extension-state-changed', state);

        let params = { shell_version: Config.PACKAGE_VERSION };

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
        this._setSummaryIcon(this.createNotificationIcon());
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
        Main.messageTray.add(this);
        this.notify(this.updates_notification);
    },

    showStartUpdates: function() {
        this._setSummaryIcon(this.createNotificationIcon());
        let params = {clear: true};
        this.updates_notification.update(_("Updating extensions..."), "", params);
    },

    showEndUpdatesSuccess: function() {
        this._setSummaryIcon(this.createNotificationIcon());
        let params = {clear: true};
        this.updates_notification.setResident(false);
        this.updates_notification.update(_("Extensions updated"), "", params);
    },

    showEndUpdatesErrors: function() {
        this._setSummaryIcon(this.createNotificationErrorIcon());
        let params = {clear: true, icon: this.createNotificationErrorIcon()};
        this.updates_notification.setResident(true);
        this.updates_notification.update(_("Failed to update some extensions"), "", params);
        this.updates_notification.addButton('update', _('Retry'));
        this.updates_notification.addButton('ignore', _('Ignore'));
    },

    showUpdateError: function(error) {
        this._setSummaryIcon(this.createNotificationErrorIcon());
        this.error_notification = new ExtensionUpdateDoneNotification(this,
            error
        );
        this.notify(this.error_notification);
    },

    showUpdateDone: function(name) {
        this.success_notification = new ExtensionUpdateDoneNotification(this,
            _("Extension '%s' updated").format(name)
        );
        this.success_notification.setTransient(true);
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
                    this.source.destroyNonResidentNotifications();
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


function init(metadata) {
    if (metadata.metadata) // 3.4
        metadata['locale'] = metadata.metadata.locale
    initTranslations(metadata);
    settings = getSettings(metadata);
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

function getSettings(metadata) {
    let schemaName = 'org.gnome.shell.extensions.updater';
    let schemaDir = metadata.path + '/schemas';

    // Extension installed in .local
    if (GLib.file_test(schemaDir + '/gschemas.compiled', GLib.FileTest.EXISTS)) {
        let schemaSource = Gio.SettingsSchemaSource.new_from_directory(schemaDir,
                                  Gio.SettingsSchemaSource.get_default(),
                                  false);
        let schema = schemaSource.lookup(schemaName, false);

        return new Gio.Settings({ settings_schema: schema });
    }
    // Extension installed system-wide
    else {
        if (Gio.Settings.list_schemas().indexOf(schemaName) == -1)
            throw "Schema \"%s\" not found.".format(schemaName);
        return new Gio.Settings({ schema: schemaName });
    }
}

function initTranslations(metadata) {
    // Extension installed in .local
    if (GLib.file_test(metadata.path + '/locale', GLib.FileTest.EXISTS)) {
        imports.gettext.bindtextdomain('gnome-shell-extension-updater', metadata.path + '/locale');
    }
    // Extension installed system-wide
    else {
        imports.gettext.bindtextdomain('gnome-shell-extension-updater', metadata.locale);
    }
}
