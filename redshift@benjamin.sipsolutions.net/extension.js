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
const Util = imports.misc.util;

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

        if (!this._settings.get_boolean(Lib.SHOW_INDICATOR_KEY))
            this.actor.hide();

        this._icon = new St.Icon({
            icon_name: 'my-redshift-sun-up-symbolic',
            style_class: 'system-status-icon'
        });

        this.actor.add_actor(this._icon);
        this.actor.add_style_class_name('panel-status-button');

        let state = this._settings.get_enum(Lib.STATE_KEY);
        this._time_based_switch = new PopupMenu.PopupSwitchMenuItem(_("Time based"), state == Lib.STATE_NORMAL);
        this._time_based_switch.connect('toggled', Lang.bind(this, this._time_based_toggled));
        this.menu.addMenuItem(this._time_based_switch);


        let item = new PopupMenu.PopupBaseMenuItem({ activate: false });
        this.menu.addMenuItem(item);

        this._night_day_slider = new Slider.Slider(0);
        this._night_day_slider_internal_udpate = false;
        this._night_day_slider.connect('value-changed', Lang.bind(this, this._night_day_sliderChanged));
        this._night_day_slider.actor.accessible_name = _("Night Day Slider");

        this._night_day_slider.setValue(this._settings.get_double(Lib.NIGHT_DAY_KEY));

        item.actor.add(this._night_day_slider.actor, { expand: true });
        item.actor.connect('button-press-event', Lang.bind(this, function(actor, event) {
            return this._night_day_slider.startDragging(event);
        }));
        item.actor.connect('key-press-event', Lang.bind(this, function(actor, event) {
            return this._night_day_slider.onKeyPressEvent(actor, event);
        }));


        let item = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(item);

        this._preferences = new PopupMenu.PopupMenuItem(_("Preferences"));
        this._preferences.connect('activate', function () {
            Util.spawn(["gnome-shell-extension-prefs", Me.metadata.uuid]);
        });
        this.menu.addMenuItem(this._preferences);

        this._configChanged();
    },

    _night_day_sliderChanged : function(slider, value) {
        if (this._night_day_slider_internal_udpate)
            return;

        this._settings.set_enum(Lib.STATE_KEY, Lib.STATE_FORCE);
        this._settings.set_double(Lib.NIGHT_DAY_KEY, value);
    },

    _setColorTemp : function(enabled, night_day) {
        this._color_settings.set_boolean("adjust-color-temperature", enabled);

        let night_temp = this._settings.get_uint(Lib.NIGHT_TEMP_KEY);
        let day_temp = this._settings.get_uint(Lib.DAY_TEMP_KEY);

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

    _time_based_toggled : function() {
        let value = this._time_based_switch.state;

        if (value)
            this._settings.set_enum(Lib.STATE_KEY, Lib.STATE_NORMAL);
        else
            this._settings.set_enum(Lib.STATE_KEY, Lib.STATE_FORCE);
    },

    _configChanged : function() {
        if (this._settings.get_boolean(Lib.SHOW_INDICATOR_KEY))
            this.actor.show();
        else
            this.actor.hide();

        this._updateLocationService();

        if (this._update_color_timeout != null) {
            Mainloop.source_remove(this._update_color_timeout);
            this._update_color_timeout = null;
        }

        let state = this._settings.get_enum(Lib.STATE_KEY);
        this._setColorTemp(true, this._settings.get_double(Lib.NIGHT_DAY_KEY));
        if (state != Lib.STATE_DISABLED) {
            if (state == Lib.STATE_NORMAL) {
                if (!this._time_based_switch.state)
                    this._time_based_switch.setToggleState(true);

                this._updateColorTempBasedOnTime();

                this._update_color_timeout = Mainloop.timeout_add_seconds(60, Lang.bind(this, function() {this._updateColorTempBasedOnTime(); return true}));
            } else { /* STATE_FORCE */
                if (this._time_based_switch.state)
                    this._time_based_switch.setToggleState(false);

                this._setColorTemp(true, this._settings.get_double(Lib.NIGHT_DAY_KEY));
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
        this._geoclue_create = new Gio.Cancellable();

        //let id = 'org.gnome.shell.extensions.redshift-gnome';
        let level = GClue.AccuracyLevel.CITY;
        let id = 'org.gnome.Maps';

        GClue.ClientProxy.create(id, level, this._geoclue_create, (function(object, result) {
            log("redshift: GClue client proxy created");
            try {
                this._geoclue = GClue.ClientProxy.create_finish(result);
            } catch (e) {
                log("redshift: GClue client proxy create_finish failed: " + e.message);
                this._geoclue = null;
                this._geoclue_create = null;
                return;
            }

            if (this._geoclue_create.is_cancelled()) {
                log('redshift: connect operation got cancelled, cleaning up')
                this._geoclue = null;
                this._geoclue_create = null;
                return;
            }

            this._notify_location_id = this._geoclue.connect('location-updated',
                                                            this._onLocationUpdated.bind(this));

            this._geoclue.call_start(this._geoclue_create, (function(object, result) {
                let res = this._geoclue.call_start_finish(result);

                if (!res) {
                    // Start failed, destroy geoclue connection again
                    this._geoclue.disconnect(this._notify_location_id)
                    this._geoclue = null;
                    this._geoclue_create = null;
                    return;
                }

                this._geoclue_create = null;
                log('redshift: GClue client created and started.')
            }).bind(this));
        }).bind(this));
    },

    _geoclueDestroy : function() {
        // Abort any startup which is in progress
        if (this._geoclue_create) {
            this._geoclue_create.cancel();
            return;
        }

        // No startup in progress, check if we even have a connection
        if (!this._geoclue)
            return;

        // Should have a connection, so disconnect handler.
        if (this._notify_location_id) {
            this._geoclue.disconnect(this._notify_location_id);
            this._notify_location_id = null;
        } else {
            log('redshift: location-update handler was not registered even though it should be!')
        }

        // Stop the client that we have
        let cancellable = new Gio.Cancellable();
        this._geoclue.call_stop(cancellable, (function(object, result) {
            // This method is not bound!
            let res = object.call_stop_finish(result);
            if (!res) {
                log('redshift: Failed to stop GClue client!')
            } else {
                log('redshift: GClue client stopped again.')
            }
        }));
        this._geoclue = null;
    },

    _updateLocationService : function() {
        let state = this._settings.get_enum(Lib.STATE_KEY);
        let time_source = this._settings.get_enum(Lib.TIME_SOURCE_KEY);

        if (state == Lib.STATE_NORMAL && time_source == Lib.TIME_SOURCE_GEOCLUE) {
            this._geoclueCreate();
        } else {
            this._geoclueDestroy();
        }
    },

    _onLocationUpdated : function(client, old_location, new_location) {
            if (!new_location || new_location == "/")
                return;

            log("redshift: GClue has a new location, querying information.");

            GClue.LocationProxy.new_for_bus(
                Gio.BusType.SYSTEM,
                0,
                "org.freedesktop.GeoClue2",
                new_location,
                null, /* cancellable */
                (function (proxy, result) {
                    let loc = GClue.LocationProxy.new_for_bus_finish(result);
                    if (loc) {
                        log("redshift: updating location using new information");
                        this._settings.set_value('last-location',
                                                 GLib.Variant.new ('ad', [loc.latitude,
                                                                          loc.longitude,
                                                                          loc.accuracy]));
                    }
                }).bind(this)
            );
    },


    _updateColorTempBasedOnTime : function() {
        let night_day = this._recalcNightDay();

        this._setColorTemp(true, night_day);
    },

    _recalcNightDay : function() {
        let night_day = 1.0;
        // Time of todays sunrise/sunset.
        let sunrise;
        let sunset;
        // Whether it is daytime or nighttime right now
        let daytime;

        let time = GLib.get_real_time() / 1000 / 1000;

        let time_source = this._settings.get_enum(Lib.TIME_SOURCE_KEY);

        if (time_source == Lib.TIME_SOURCE_FIXED) {
            sunrise = this._settings.get_uint(Lib.SUNRISE_TIME_KEY);
            sunset = this._settings.get_uint(Lib.SUNSET_TIME_KEY);

            /* Add last midnight to sunset/sunrise times to calculate todays
             * time of the sunrise and sunset. */
            let dt = GLib.DateTime.new_now_local();
            let ymd = dt.get_ymd();
            dt = GLib.DateTime.new_local(ymd[0], ymd[1], ymd[2], 0, 0, 0);
            sunrise = sunrise + dt.to_unix();
            sunset = sunset + dt.to_unix();

            if (sunrise < sunset) {
                daytime = time > sunrise && time < sunset;
            } else {
                daytime = time > sunrise || time < sunset;
            }
        } else {
            let lastLocation = this._settings.get_value('last-location').deep_unpack();
            let latitude, longitude, accuracy;

            if (lastLocation.length >= 3) {
                latitude = lastLocation[0]
                longitude = lastLocation[1]
                accuracy = lastLocation[2];
            } else {
                log("redshift: Don't have any location (neither GeoClue nor cached) assuming daytime!");
                return night_day;
            }

            let world = GWeather.Location.new_world(false);
            let city = world.find_nearest_city(latitude, longitude);

            // What meaning does the forecast type have?
            let info = new GWeather.Info({location: city});
            sunrise = info.get_value_sunrise();
            sunset = info.get_value_sunset();
            daytime = info.is_daytime();

            if (!sunrise[0] || !sunset[0]) {
                /* Polar summer/winter. Unfortunately we cannot determine any dusk/dawn times. */
                if (daytime) {
                    night_day = 1.0;
                } else {
                    night_day = 0.0;
                }
                return night_day;
            }
            sunrise = sunrise[1];
            sunset = sunset[1];
        }

        let dusk_dawn_length = this._settings.get_uint(Lib.DUSK_DAWN_LENGTH_KEY) * 60;

        /* Ensure that we select the "closest" sunrise/sunset time, this might
         * be the one from the next or previous day. */
        if (daytime && sunrise > time)
            sunrise = sunrise - 24 * 60 * 60;
        if (!daytime && sunrise < time)
            sunrise = sunrise + 24 * 60 * 60;

        if (!daytime && sunset > time)
            sunset = sunset - 24 * 60 * 60;
        if (daytime && sunset < time)
            sunset = sunset + 24 * 60 * 60;

        if (daytime) {
            let dawn = 0.5 + (time - sunrise) / dusk_dawn_length;
            let dusk = 0.5 + (sunset - time) / dusk_dawn_length;

            night_day = Math.min(1.0, dawn, dusk);
        } else {
            let dawn = 0.5 - (sunrise - time) / dusk_dawn_length;
            let dusk = 0.5 - (time - sunset) / dusk_dawn_length;

            night_day = Math.max(0.0, dawn, dusk);
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
