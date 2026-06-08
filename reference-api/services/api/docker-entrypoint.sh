#!/bin/bash
set -e

# Wait for Postgres (Python has psycopg2)
python -c "
import os, time, sys
import psycopg2
url = os.environ.get('DATABASE_URL', 'postgresql://ctref:ctref@db:5432/ctref')
for i in range(30):
    try:
        psycopg2.connect(url)
        break
    except Exception:
        time.sleep(2)
else:
    sys.exit(1)
"

# Run seed
python -m seed.seed

exec "$@"
