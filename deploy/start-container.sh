#!/bin/sh
set -eu

openclaw gateway run &

exec supervisord -c /app/deploy/supervisord.conf
