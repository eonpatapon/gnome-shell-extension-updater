# gnome-shell-extension-updater

This extension check updates every 5 days for all extensions installed from
https://extensions.gnome.org.

This extension supports gnome-shell 3.2 and 3.4

# Screenshots

![Screenshot](https://github.com/eonpatapon/gnome-shell-extension-updater/raw/master/data/screenshot.png)

![Screenshot](https://github.com/eonpatapon/gnome-shell-extension-updater/raw/master/data/screenshot1.png)

![Screenshot](https://github.com/eonpatapon/gnome-shell-extension-updater/raw/master/data/screenshot2.png)

# Installation

Prerequisites: automake, gnome-common, gettext, glib2 devel files

## System wide (*for gnome-shell 3.2 and 3.4*)

    ./autogen.sh
    make
    sudo make install

## In your .local directory (*only for gnome-shell 3.4*)

    ./autogen.sh
    make
    make install-zip


Restart the shell and then enable the extension.
