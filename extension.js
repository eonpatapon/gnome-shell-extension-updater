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
const Gettext = imports.gettext.domain('gnome-shell-extension-updater');
const _ = Gettext.gettext;

const UPDATE_INTERVAL = 86400; // 24 hours

const _httpSession = new Soup.SessionAsync();

if (Soup.Session.prototype.add_feature != null)
    Soup.Session.prototype.add_feature.call(_httpSession, new Soup.ProxyResolverDefault());

// Used to store the extensions that can be updated
let extensions = {};
// ExtensionStateChanged signal id
let stateChangedId = false;

function ExtensionSource() {
    this._init.apply(this, arguments);
}

ExtensionSource.prototype = {
    __proto__: MessageTray.Source.prototype,

    _init: function(uuid, version, name, state) {
        MessageTray.Source.prototype._init.call(this, _("Extension update"));
        this.uuid = uuid;
        this.version = version;
        this.name = name;
        this.state = state;
        this._data = false;
        this._timeoutId = false;
    },

    checkUpdates: function() {
        let params = {'uuid': this.uuid, 'shell_version': Config.PACKAGE_VERSION};
        let message = Soup.form_request_new_from_hash('GET', 
            ExtensionSystem.REPOSITORY_URL_INFO, params);

        _httpSession.queue_message(message, 
            Lang.bind(this, function(session, message) {
                let wait = UPDATE_INTERVAL;

                if (message.status_code == 200) {
                    this._data = JSON.parse(message.response_body.data);
                    if (this._data && this._data.version > this.version)
                        this.showNotification();
                }
                else {
                    wait = 300; // 5min
                }
                
                this.checkTimeout(wait);
            })
        );

    },

    checkTimeout: function(time) {
        this._timeoutId = Mainloop.timeout_add_seconds(time, 
            Lang.bind(this, this.checkUpdates)
        );
    },

    showNotification: function() {
        if (this.notifications.length == 0) {
            let notification = new ExtensionUpdateNotification(this,
                _("Extension update available"),
                _("Update the extension <b>%s</b> to the lastest version ?").format(this.name)
            );
            this._setSummaryIcon(this.createNotificationIcon());
            Main.messageTray.add(this);
            this.notify(notification);
        }
    },

    updateExtension: function() {
        ExtensionSystem.uninstallExtensionFromUUID(this.uuid);
        ExtensionSystem.installExtensionFromUUID(this.uuid, 
            this._data.version_tag.toString());
    },

    checkInstall: function(meta) {
        if (this.state == ExtensionSystem.ExtensionState.DOWNLOADING &&
            meta.state == ExtensionSystem.ExtensionState.ENABLED) {
                let notification = new MessageTray.Notification(this, 
                    _("Extension '%s' updated").format(this.name), null);
                this.notify(notification);
        }

        if (this.state == ExtensionSystem.ExtensionState.DOWNLOADING &&
            meta.state == ExtensionSystem.ExtensionState.ERROR) {
                let notification = new MessageTray.Notification(this, 
                    _("Error while updating extension '%s'").format(this.name), 
                    null);
                this.notify(notification);
        }

        this.state = meta.state;
    },

    createNotificationIcon: function() {
        return new St.Icon({icon_name: 'software-update-available',
                            icon_size: this.ICON_SIZE,
                            icon_type: St.IconType.FULLCOLOR});
    },

    destroy: function() {
        if (this._timeoutId)
            Mainloop.source_remove(this._timeoutId);
        MessageTray.Source.prototype.destroy.call(this);
    }
}

function ExtensionUpdateNotification() {
    this._init.apply(this, arguments);
}

ExtensionUpdateNotification.prototype = {
    __proto__: MessageTray.Notification.prototype,

    _init: function(source, title, body) {
        MessageTray.Notification.prototype._init.call(this, source,
                                                      title, null,
                                                      { customContent: true,
                                                        bodyMarkup: true });

        this.addBody(body, true);
        this.addButton('update', _("Update"));
        this.addButton('ignore', _("Ignore"));

        this.connect('action-invoked', Lang.bind(this, function(self, action) {
            switch (action) {
                case 'update':
                    log("Updating extension %s".format(source.uuid));
                    source.updateExtension();
                    break;
                case 'ignore':
                default:
            }
            this.destroy();
        }));
    }
}


function getExtensionList() {
    for (uuid in ExtensionSystem.extensionMeta) {
        // Get enabled extensions installed from e.g.o
        if (!extensions[uuid] && uuid != "updater@patapon.info" &&
            ExtensionSystem.extensionMeta[uuid].type == ExtensionSystem.ExtensionType.PER_USER && 
            ExtensionSystem.extensionMeta[uuid].state == ExtensionSystem.ExtensionState.ENABLED &&
            ExtensionSystem.extensionMeta[uuid].version) {
                let extension = new ExtensionSource(uuid, 
                    ExtensionSystem.extensionMeta[uuid].version, 
                    ExtensionSystem.extensionMeta[uuid].name,
                    ExtensionSystem.extensionMeta[uuid].state);
                extensions[uuid] = extension;
        }
    }
}

function checkUpdates() {
    // Check updates immediately
    for (let uuid in extensions) {
        extensions[uuid].checkUpdates();
    }
}

function extensionStateChanged(source, meta) {
    if (extensions[meta.uuid]) {
        // Extension uninstalled
        if (meta.state == ExtensionSystem.ExtensionState.UNINSTALLED) {
            extensions[meta.uuid].destroy();
            delete extensions[meta.uuid];
        }
        // Check installation status
        else
            extensions[meta.uuid].checkInstall(meta);
    }
    // New extension installed
    else if (meta.state == ExtensionSystem.ExtensionState.ENABLED) {
        // Add the new extension to the list
        getExtensionList();
        // Program the next update check
        extensions[meta.uuid].checkTimeout(UPDATE_INTERVAL);
    }
}

function init(metadata) {
    imports.gettext.bindtextdomain('gnome-shell-extension-updater', metadata.path + '/locale');
}

function enable() {
    // Wait that all extensions are loaded
    Mainloop.timeout_add_seconds(10, function() {
        getExtensionList();
        checkUpdates();
        stateChangedId = ExtensionSystem.connect('extension-state-changed', 
                            extensionStateChanged);
    });
}

function disable() {
    for (let uuid in extensions)
        extensions[uuid].destroy();
    extensions = {};
    ExtensionSystem.disconnect(stateChangedId);
    stateChangedId = false;
}
