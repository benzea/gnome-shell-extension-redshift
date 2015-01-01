#!/bin/sh

set -e

rm -f redshift@benjamin.sipsolutions.net.zip

cd redshift@benjamin.sipsolutions.net

glib-compile-schemas schemas

find . -name \*~ -exec rm -f {} \;

zip -r ../redshift@benjamin.sipsolutions.net.zip *
