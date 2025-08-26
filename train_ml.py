# scripts/train_ml.py
# Đọc data/dataset_ml.csv (từ backfill), train logistic đơn giản cho XSMB (00..99).
# Xuất data/ml_weights.json để build-json.mjs blend vào điểm.
import json, pandas as pd
from pathlib import Path
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import log_loss

ROOT = Path('.')
csv = ROOT/'data'/'dataset_ml.csv'
df = pd.read_csv(csv)
df = df[df['game']=='xsmb'].copy()
# tạo feature đơn giản: rolling counts (không có sẵn -> tạo giả định từ last_seen)
df['last_seen_days'] = df['last_seen_days'].fillna(999).clip(0, 999)
# target: 1 nếu số xuất hiện >=1 trong ngày
y = df['target'].values
X = df[['last_seen_days']].values

pipe = Pipeline([('sc', StandardScaler()), ('lr', LogisticRegression(max_iter=1000))])
# train toàn bộ (time split có thể thêm)
pipe.fit(X, y)
# score theo xác suất -> quy về trọng số nhỏ
proba = pipe.predict_proba(X)[:,1]
df['p'] = proba

# lấy trọng số cuối mỗi ngày cho từng số (gần đây ưu tiên)
weights = {}
for n, g in df.groupby('number'):
    w = g.tail(1)['p'].values[0]
    # scale nhỏ để chỉ "blend", không áp đảo thống kê: [-0.2, +0.2]
    weights[n] = float(max(-0.2, min(0.2, w - 0.5)))

out = {'xsmb': weights}
(ROOT/'data'/'ml_weights.json').write_text(json.dumps(out, indent=2))
print('Wrote data/ml_weights.json with', len(weights), 'entries')
