#!/bin/bash

DIR=$HOME/.local/share/gnome-shell/extensions/updater@patapon.info

zip -x *.pot* -r updater@patapon.info.zip extension.js metadata.json COPYING locale
mkdir -p $DIR
unzip updater@patapon.info.zip -d $DIR
