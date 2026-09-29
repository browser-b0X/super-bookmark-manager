import storage; storage.init_db()
import sqlite3, config
conn = sqlite3.connect(config.DB_PATH)
conn.execute('UPDATE saved_posts SET processed = 0')
conn.commit()
conn.close()
from categorizer import categorize_unprocessed
categorize_unprocessed()
conn = sqlite3.connect(config.DB_PATH)
stats = conn.execute('SELECT category, COUNT(*) as c FROM saved_posts GROUP BY category ORDER BY c DESC').fetchall()
print('---RESULTS---')
for cat, c in stats:
    print(f'{cat}: {c}')
conn.close()
