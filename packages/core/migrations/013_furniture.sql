-- moved furniture per building: piece key -> lot-relative anchor (only pieces away from their default spot).
ALTER TABLE buildings ADD COLUMN furniture TEXT NOT NULL DEFAULT '{}';
