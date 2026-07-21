-- Delivery tracking for answered questions: stamped the first time an orient surfaces the answer.
ALTER TABLE companion_questions ADD COLUMN delivered_at TEXT;
