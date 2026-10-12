#!/usr/bin/env python3.12
import sqlite3, config, storage
storage.init_db()
conn = sqlite3.connect(config.DB_PATH)
conn.execute('UPDATE saved_posts SET processed = 0')
conn.commit()
conn.close()
print("Reset done. Running categorizer...")

from categorizer import categorize_unprocessed
categorize_unprocessed()

conn = sqlite3.connect(config.DB_PATH)
stats = conn.execute('SELECT category, COUNT(*) as c FROM saved_posts GROUP BY category ORDER BY c DESC').fetchall()
print("\nDistribution:")
for cat, c in stats:
    print(f"  {cat}: {c}")
conn.close()
print("\nDone!")
