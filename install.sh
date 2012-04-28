#!/bin/bash

bash update-mo.sh
glib-compile-schemas schema

rm -f updater@patapon.info.zip
DIR=$HOME/.local/share/gnome-shell/extensions/updater@patapon.info

zip -x *.pot* -r updater@patapon.info.zip extension.js metadata.json COPYING \
                                          locale/*/*/*.mo schema

rm -rf $DIR
mkdir -p $DIR
unzip updater@patapon.info.zip -d $DIR
