#!/usr/bin/env bash
# Download GeoNames source data needed by build_gazetteer.py.
# Files are not checked into the repo; rerun this script to fetch them.
set -euo pipefail
cd "$(dirname "$0")"

curl -sSL --max-time 120 -o cities500.zip   'https://download.geonames.org/export/dump/cities500.zip'
curl -sSL --max-time 120 -o cities15000.zip 'https://download.geonames.org/export/dump/cities15000.zip'
curl -sSL --max-time 120 -o US.zip          'https://download.geonames.org/export/dump/US.zip'
curl -sSL --max-time 30  -o admin1.txt      'https://download.geonames.org/export/dump/admin1CodesASCII.txt'
curl -sSL --max-time 30  -o countryInfo.txt 'https://download.geonames.org/export/dump/countryInfo.txt'

ls -lh cities500.zip cities15000.zip US.zip admin1.txt countryInfo.txt
