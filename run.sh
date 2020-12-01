#!/bin/bash

python3 -u ogs-client.py3 $1 | npm start -- -c config.json -j '{"repl": true}'
