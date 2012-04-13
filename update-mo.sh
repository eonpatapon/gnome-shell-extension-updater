#!/bin/bash

for name in `find . -type f -name "*.po"`
  do
    newname=`echo ${name} | sed 's!^\(.*\)/\(.*\).po$!\1/\2.mo!'`
    echo -n "Building ${name} as ${newname}..."
    msgfmt ${name} -o ${newname} || true
    echo "done"
  done

