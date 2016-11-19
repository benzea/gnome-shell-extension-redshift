// -*- mode: js2; indent-tabs-mode: nil; js2-basic-offset: 4 -*-
// Adapted from auto-move-windows@gnome-shell-extensions.gcampax.github.com

const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Lang = imports.lang;
const GObject = imports.gi.GObject;
const Config = imports.misc.config;

const Gettext = imports.gettext.domain('gnome-shell-extension-redshift');
const _ = Gettext.gettext;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Lib = Me.imports.lib;


let ShellVersion = parseInt(Config.PACKAGE_VERSION.split(".")[1]);

const RedshiftWidget = new Lang.Class({
    Name: 'RedshiftWidget',

    _init: function(params) {
        this.w = new Gtk.Grid(params);
        this.w.set_orientation(Gtk.Orientation.VERTICAL);
        this.w.set_row_spacing(5);
        this.w.set_column_spacing(5);

        this._settings = Lib.getSettings(Me);
        this._settings.connect('changed', Lang.bind(this, this._refresh));


        let label = new Gtk.Label({label: _("Show Redshift in top panel"),
                                           xalign: 0});

        let show = new Gtk.Switch({active: this._settings.get_boolean(Lib.SHOW_INDICATOR_KEY)});
        show.connect('notify::active', Lang.bind(this, function(button) {
            this._settings.set_boolean(Lib.SHOW_INDICATOR_KEY, button.active);
        }));

        this.w.attach(label, 0, 1, 1, 1);
        this.w.attach(show, 1, 1, 1, 1);


        let label = new Gtk.Label({label: _("Daytime color temperature (neutral: 6500K)"),
                                           xalign: 0});

        let temp = new Gtk.SpinButton();
        temp.set_range(1000, 10000);
        temp.set_value(this._settings.get_uint(Lib.DAY_TEMP_KEY));
        temp.set_digits(0);
        temp.set_increments(50, 250);
        temp.connect('notify::value', Lang.bind(this, function(button) {
            this._settings.set_uint(Lib.DAY_TEMP_KEY, Math.round(button.value));
        }));

        this.w.attach(label, 0, 2, 1, 1);
        this.w.attach(temp, 1, 2, 1, 1);

        let label = new Gtk.Label({label: _("Nighttime color temperature (e.g.: 2750K)"),
                                           xalign: 0});

        let temp = new Gtk.SpinButton();
        temp.set_range(1000, 10000);
        temp.set_value(this._settings.get_uint(Lib.NIGHT_TEMP_KEY));
        temp.set_digits(0);
        temp.set_increments(50, 250);
        temp.connect('notify::value', Lang.bind(this, function(button) {
            this._settings.set_uint(Lib.NIGHT_TEMP_KEY, Math.round(button.value));
        }));

        this.w.attach(label, 0, 3, 1, 1);
        this.w.attach(temp, 1, 3, 1, 1);

        let label = new Gtk.Label({label: _("Length of the dusk/dawn progression in minutes"),
                                           xalign: 0});

        let length = new Gtk.SpinButton();
        length.set_range(10, 120);
        length.set_value(this._settings.get_uint(Lib.DUSK_DAWN_LENGTH_KEY));
        length.set_digits(0);
        length.set_increments(1, 5);
        length.connect('notify::value', Lang.bind(this, function(button) {
            this._settings.set_uint(Lib.DUSK_DAWN_LENGTH_KEY, Math.round(button.value));
        }));

        this.w.attach(label, 0, 4, 1, 1);
        this.w.attach(length, 1, 4, 1, 1);


    },

    _refresh: function() {
        // Do nothing for now, just assume no one else is editing the settings
    }
});

function init() {
    Lib.initTranslations(Me);
}

function buildPrefsWidget() {
    let widget = new RedshiftWidget();
    widget.w.show_all();

    return widget.w;
}
