Redshift GNOME shell extension
==============================

This redshift extension is a native redshift implementation for GNOME. For
it to work, patching the color management of gnome-settings-daemon is
required. However, because it hooks into the GNOME color management, any
color profile that adjusts the gamma curves of the monitor automatically
will still work.

Installation
============

To install the extension, run ./make-zip.sh and install the created zipfile.

To use it, you also need to apply the gnome-settings-daemon patch, which is in
the patches subdirectory. A version for 3.22 and current master (2016-11-19)
is supplied, although only the 3.22 version is tested.

This extension will do nothing if you do not patch gnome-settings-daemon!

See also:
 * https://bugzilla.gnome.org/show_bug.cgi?id=741224
 * https://bugzilla.gnome.org/show_bug.cgi?id=742149

Configuration
=============

Click on Preferences, use gnome-tweak-tool or https://extensions.gnome.org to
open the configuration dialog. There you can configure:

 * The daytime color temperature (default: 6500K)
 * The nighttime color temperature (default: 3500K)
 * Whether to show the indicator (default: yes)
 * The length of dusk/dawn (default: 60 minutes)
 * Sunrise/sunset calculation mode (geoclue locaion, last known location, fixed time)
   (default: geoclue)
 * The sunrise/sunset time when in fixed time mode based on the local time
   (default: 7:30 and 19:30)

Location
========

The shell will prompt you to give GNOME Maps access to the current location
this is because redshift uses this location to calculate the dusk and dawn
times.

You might have to enable Location Services under All Settings -> Privacy
for this to work if Gnome is not prompting for permission.

Bugs/Issues/Improvements
========================

* Currently the gnome-maps ID is used for GeoClue. Using our own does not work
  without providing a desktop file (and I am not sure how to ship that)
* The preference dialog is ugly
