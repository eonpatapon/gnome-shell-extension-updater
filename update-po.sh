#!/bin/bash

POT=locale/gnome-shell-extension-updater.pot

rm -f $POT
touch $POT

xgettext -C -j -o ${POT} --language=Python --keyword=_ extension.js

for PO in `find locale -type f -name *.po`; do
    echo -n "updating $PO... "
    msgmerge --update --add-location --sort-output $PO $POT
    echo "done"                                                              
done                                                                         
