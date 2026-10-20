-- waiting design P1: an assignment can wait on a dependency (JSON WaitFor; NULL = runnable)
ALTER TABLE assignments ADD COLUMN waitFor TEXT;
ALTER TABLE assignments ADD COLUMN parked INTEGER;
