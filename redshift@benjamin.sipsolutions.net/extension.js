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
const Geoclue = Me.imports.geoclue;
const GWeather = imports.gi.GWeather;

const IndicatorName = "redshift";

let RedshiftIndicator;
let ShellVersion = parseInt(Config.PACKAGE_VERSION.split(".")[1]);

const Redshift = new Lang.Class({
    Name: IndicatorName,
    Extends: PanelMenu.Button,

    _init: function(metadata, params) {
        this.parent(null, IndicatorName);

        this._settings = Lib.getSettings(Me);
        this._settings.connect("changed", Lang.bind(this, this._configChanged));

        this._geoclue = new Geoclue.Geoclue(this._settings);
        this._geoclue.connect('notify::connected', Lang.bind(this, this._onGeoclueConnected))
        this._geoclue.connect('location-changed', Lang.bind(this, this._locationChanged))

        this._color_settings = new Gio.Settings({ schema: 'org.gnome.settings-daemon.plugins.color' });

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

//        let icon = new St.Icon({ icon_name: 'display-brightness-symbolic',
//                                 style_class: 'popup-menu-icon' });
//        item.actor.add(icon);
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

    _onGeoclueConnected : function(geoclue, pspec) {
        this._updateLocationService();
    },

    _updateLocationService : function() {
        let state = this._settings.get_enum(STATE_KEY);
        if (state == STATE_NORMAL) {
            this._geoclue.start();
        } else {
            this._geoclue.stop();
        }
    },

    _locationChanged : function(geoclue, loc) {
        let state = this._settings.get_enum(STATE_KEY);
        if (state == STATE_NORMAL) {
            this._updateColorTempBasedOnTime();
        }
    },

    _updateColorTempBasedOnTime : function() {
        let night_day = this._recalcNightDay();

        this._setColorTemp(true, night_day);
    },

    _recalcNightDay : function() {
        let night_day = 1.0;

        let world = GWeather.Location.new_world(false);
        let geoloc = this._geoclue.location;
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
        this._geoclue.stop();

        this._setColorTemp(false, 1.0);

        // disconnect from signals
        this.parent();
    }
});

function init(extensionMeta) {
    Lib.initTranslations(Me);
    let theme = imports.gi.Gtk.IconTheme.get_default();
    theme.append_search_path(extensionMeta.path + "/icons");
}

function enable() {
    RedshiftIndicator = new Redshift();
    Main.panel.addToStatusArea(IndicatorName, RedshiftIndicator);
}

function disable() {
    RedshiftIndicator.destroy();
    RedshiftIndicator = null;
}
