/* -*- mode: js2 - indent-tabs-mode: nil - js2-basic-offset: 4 -*- */
/*jshint multistr:true */
/*jshint esnext:true */
/*global imports: true */
/*global global: true */
/*global log: true */
/*global logError: true */
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

'use strict';

const Lang = imports.lang;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const GClue = imports.gi.Geoclue;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Shell = imports.gi.Shell;
const MessageTray = imports.ui.messageTray;
const Config = imports.misc.config;
const Slider = imports.ui.slider;


const SHOW_INDICATOR_KEY = 'show-indicator';
const STATE_KEY = 'state';
const NIGHT_TEMP_KEY = 'night-color-temperature';
const DAY_TEMP_KEY = 'day-color-temperature';
const NIGHT_DAY_KEY = 'night-day';

const STATE_DISABLED = 0;
const STATE_NORMAL = 1;
const STATE_FORCE = 2;

const Gettext = imports.gettext.domain('gnome-shell-extension-redshift');
const _ = Gettext.gettext;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Lib = Me.imports.lib;
const GWeather = imports.gi.GWeather;
const Geocode = imports.gi.GeocodeGlib;

const IndicatorName = "redshift";

let RedshiftIndicator;
let ShellVersion = parseInt(Config.PACKAGE_VERSION.split(".")[1]);

const Redshift = new Lang.Class({
    Name: IndicatorName,
    Extends: PanelMenu.Button,

    _init: function(metadata, params) {
        this.parent(null, IndicatorName);

        this._settings = Lib.getSettings(Me);
        this._settings_changed_id = this._settings.connect("changed", Lang.bind(this, this._configChanged));

        this._color_settings = new Gio.Settings({ schema: 'org.gnome.settings-daemon.plugins.color' });

        this._notify_location_id = null;
        this._geoclue_create = null;
        this._update_color_timeout = null;

        if (!this._settings.get_boolean(SHOW_INDICATOR_KEY))
            this.actor.hide();

        this._icon = new St.Icon({
            icon_name: 'my-redshift-sun-up-symbolic',
            style_class: 'system-status-icon'
        });

        this.actor.add_actor(this._icon);
        this.actor.add_style_class_name('panel-status-button');

        let state = this._settings.get_enum(STATE_KEY);
        this._location_based_switch = new PopupMenu.PopupSwitchMenuItem(_("Location based"), state == STATE_NORMAL);
        this._location_based_switch.connect('toggled', Lang.bind(this, this._location_based_toggled));
        this.menu.addMenuItem(this._location_based_switch);


        let item = new PopupMenu.PopupBaseMenuItem({ activate: false });
        this.menu.addMenuItem(item);

        this._night_day_slider = new Slider.Slider(0);
        this._night_day_slider_internal_udpate = false;
        this._night_day_slider.connect('value-changed', Lang.bind(this, this._night_day_sliderChanged));
        this._night_day_slider.actor.accessible_name = _("Night Day Slider");

        this._night_day_slider.setValue(this._settings.get_double(NIGHT_DAY_KEY));

        item.actor.add(this._night_day_slider.actor, { expand: true });
        item.actor.connect('button-press-event', Lang.bind(this, function(actor, event) {
            return this._night_day_slider.startDragging(event);
        }));
        item.actor.connect('key-press-event', Lang.bind(this, function(actor, event) {
            return this._night_day_slider.onKeyPressEvent(actor, event);
        }));

        this._configChanged();
    },

    _night_day_sliderChanged : function(slider, value) {
        if (this._night_day_slider_internal_udpate)
            return;

        this._settings.set_enum(STATE_KEY, STATE_FORCE);
        this._settings.set_double(NIGHT_DAY_KEY, value);
    },

    _setColorTemp : function(enabled, night_day) {
        this._color_settings.set_boolean("adjust-color-temperature", enabled);

        let night_temp = this._settings.get_uint(NIGHT_TEMP_KEY);
        let day_temp = this._settings.get_uint(DAY_TEMP_KEY);

        let temp = Math.round(night_temp * (1 - night_day) + day_temp * night_day);

        this._color_settings.set_int("color-temperature", temp);

        if (enabled) {
            if (night_day < 0.1) {
                this._icon.icon_name = "my-redshift-moon-symbolic";
            } else if (night_day < 0.5) {
                this._icon.icon_name = "my-redshift-sun-semi-down-symbolic";
            } else if (night_day < 0.9) {
                this._icon.icon_name = "my-redshift-sun-semi-up-symbolic";
            } else {
                this._icon.icon_name = "my-redshift-sun-up-symbolic";
            }
        } else {
            this._icon.icon_name = "my-redshift-sun-up-symbolic";
        }

        this._night_day_slider_internal_udpate = true;
        this._night_day_slider.setValue(night_day);
        this._night_day_slider_internal_udpate = false;
    },

    _location_based_toggled : function() {
        let value = this._location_based_switch.state;

        if (value)
            this._settings.set_enum(STATE_KEY, STATE_NORMAL);
        else
            this._settings.set_enum(STATE_KEY, STATE_FORCE);
    },

    _configChanged : function() {
        if (this._settings.get_boolean(SHOW_INDICATOR_KEY))
            this.actor.show();
        else
            this.actor.hide();

        this._updateLocationService();

        if (this._update_color_timeout != null) {
            Mainloop.source_remove(this._update_color_timeout);
            this._update_color_timeout = null;
        }

        let state = this._settings.get_enum(STATE_KEY);
        this._setColorTemp(true, this._settings.get_double(NIGHT_DAY_KEY));
        if (state != STATE_DISABLED) {
            if (state == STATE_NORMAL) {
                if (!this._location_based_switch.state)
                    this._location_based_switch.setToggleState(true);

                this._updateColorTempBasedOnTime();

                this._update_color_timeout = Mainloop.timeout_add_seconds(60, Lang.bind(this, function() {this._updateColorTempBasedOnTime(); return true}));
            } else { /* STATE_FORCE */
                if (this._location_based_switch.state)
                    this._location_based_switch.setToggleState(false);

                this._setColorTemp(true, this._settings.get_double(NIGHT_DAY_KEY));
            }
        } else {
                this._setColorTemp(false, 1.0);
        }
    },

    _geoclueCreate : function() {
        if (this._geoclue != null || this._geoclue_create != null)
            return;

        log('redshift: creating geoclue client')

        /* Empty placeholder */
        this._geoclue = null
        /* Not passed in to constructor, as actually cancelling the setup
         * doesn't stop the services. */
        this._geoclue_create = new Gio.Cancellable();

        //let id = 'org.gnome.shell.extensions.redshift-gnome';
        //let level = GClue.AccuracyLevel.CITY;
        let id = 'org.gnome.Maps';
        let level = GClue.AccuracyLevel.EXACT;

        GClue.Simple.new(id, level, null, (function(object, result) {
            log("redshift: gclue simple created");
            try {
                this._geoclue = GClue.Simple.new_finish(result);
            }
            catch (e) {
                log("GeoClue2 service: " + e.message);
                this._geoclue = null;
                this._geoclue_create = null;
                return;
            }

            if (this._geoclue_create.is_cancelled()) {
                log('redshift: connect operation got cancelled, ensuring disconnect')
                let client = this._geoclue.get_client();
                let cancellable = new Gio.Cancellable();
                if (client)
                    client.call_stop_sync(cancellable);

                this._geoclue = null;
                this._geoclue_create = null;
                return;
            }
            this._geoclue_create = null;

            log('redshift: geoclue client created and active', this._geoclue)

            this._notify_location_id = this._geoclue.connect('notify::location',
                                                            this._onLocationNotify.bind(this));

            this._onLocationNotify(this._geoclue);
        }).bind(this));
    },

    _geoclueDestroy : function() {
        if (this._geoclue_create) {
            log('redshift: cancelling connect')
            this._geoclue_create.cancel();
        }

        if (this._geoclue == null)
            return;

        log('redshift: destroying geoclue client')

        if (this._notify_location_id) {
            log('redshift: disconnecting location notification callback')
            this._geoclue.disconnect(this._notify_location_id);
        }

        let client = this._geoclue.get_client();
        if (client) {
            let cancellable = new Gio.Cancellable();
            log('redshift: sending explicit stop')
            client.call_stop_sync(cancellable);
        }

        this._notify_location_id = null;
        this._geoclue = null;
        log('redshift: geoclue client destroyed')
    },

    _updateLocationService : function() {
        let state = this._settings.get_enum(STATE_KEY);
        if (state == STATE_NORMAL) {
            this._geoclueCreate();
        } else {
            this._geoclueDestroy();
        }
    },

    _onLocationNotify : function(simple) {
        let state = this._settings.get_enum(STATE_KEY);

        log('redshift: got location notification from geoclue')

        // Update stored location
        let loc = simple.get_location();
        if (loc != null)
            this._settings.set_value('last-location',
                                     GLib.Variant.new ('ad', [loc.latitude,
                                                              loc.longitude,
                                                              loc.accuracy]));

        // _recalcNightDay will be called because the settings were updated.
    },

    _updateColorTempBasedOnTime : function() {
        let night_day = this._recalcNightDay();

        this._setColorTemp(true, night_day);
    },

    _recalcNightDay : function() {
        let night_day = 1.0;
        let geoloc = null;

        let lastLocation = this._settings.get_value('last-location').deep_unpack();
        if (lastLocation.length >= 3) {
            let [lat, lng, accuracy] = lastLocation;
            geoloc = new Geocode.Location({ latitude: lat,
                                            longitude: lng,
                                            accuracy: accuracy });
        }

        if (geoloc === null) {
            log("redshift: Don't have any location (neither GeoClue nor cached) assuming daytime!");
            return night_day;
        }

        let world = GWeather.Location.new_world(false);
        let city = world.find_nearest_city(geoloc.latitude, geoloc.longitude);

        // What meaning does the forecast type have?
        let info = new GWeather.Info({location: city});
        let sunrise = info.get_value_sunrise();
        let sunset = info.get_value_sunset();
        let daytime = info.is_daytime();

        let time = GLib.get_real_time() / 1000 / 1000;

        let dusk_dawn_length = 60 * 60;

        if (sunrise[0] && sunset[0]) {
            /* We are not in polar summer/winter, we can do normal calculations. */

            if (daytime) {
                let dawn = 0.5 + (time - sunrise[1]) / dusk_dawn_length * 0.25;
                let dusk = 0.5 + (sunset[1] - time) / dusk_dawn_length * 0.25;

                night_day = Math.min(1.0, dawn, dusk);
            } else {
                /* At night we need to shift sunrise/sunset to the next/previous day. */
                if (sunrise[1] < time)
                    sunrise[1] = sunrise[1] + 24 * 60 * 60;
                if (sunset[1] > time)
                    sunset[1] = sunset[1] - 24 * 60 * 60;

                let dawn = 0.5 - (sunrise[1] - time) / dusk_dawn_length * 0.25;
                let dusk = 0.5 - (time - sunset[1]) / dusk_dawn_length * 0.25;

                night_day = Math.max(0.0, dawn, dusk);
            }
        } else {
            /* Polar summer/winter. Unfortunately we cannot determine any dusk/dawn times. */
            if (daytime) {
                night_day = 1.0;
            } else {
                night_day = 0.0;
            }
        }

        return night_day;
    },

    destroy: function() {
        this._geoclueDestroy();

        // disconnect from signals and timeouts
        this._settings.disconnect(this._settings_changed_id);
        if (this._update_color_timeout != null) {
            Mainloop.source_remove(this._update_color_timeout);
            this._update_color_timeout = null;
        }
        this.parent();

        this._setColorTemp(false, 1.0);
    }
});

function init(extensionMeta) {
    Lib.initTranslations(Me);
    let theme = imports.gi.Gtk.IconTheme.get_default();
    theme.append_search_path(extensionMeta.path + "/icons");
}

function enable() {
    log('redshift: enabling extension')

    RedshiftIndicator = new Redshift();
    Main.panel.addToStatusArea(IndicatorName, RedshiftIndicator);
}

function disable() {
    log('redshift: disabling extension')

    RedshiftIndicator.destroy();
    RedshiftIndicator = null;
}
