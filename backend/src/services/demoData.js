// Seed content for the Product Service / Order Service demonstration.
// Each script is a real migration that runs against the demo database.

export const DEMO_PROJECTS = [
  {
    slug: 'product_service',
    name: 'Product Service',
    description: 'Catalog microservice. Demonstrates an expand/contract change of price (numeric) to price_cents (integer).',
    primary_table: 'products',
    apps: [
      { version: 'v1.0', requires: { products: ['id', 'sku', 'name', 'price'] } },
    ],
    scripts: [
      {
        version: 1,
        description: 'Create products table',
        phase: 'standard',
        up: `CREATE TABLE products (
  id          SERIAL PRIMARY KEY,
  sku         VARCHAR(32) NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  price       NUMERIC(10,2) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO products (sku, name, price) VALUES
  ('KB-101', 'Mechanical keyboard', 4599.00),
  ('MS-220', 'Wireless mouse', 1299.50),
  ('HD-330', 'USB-C hub', 2499.00),
  ('MN-440', '27 inch monitor', 18999.00),
  ('CB-550', 'Braided cable', 349.99);`,
        down: `DROP TABLE products;`,
      },
      {
        version: 2,
        description: 'Expand: add price_cents and keep it in sync',
        phase: 'expand',
        up: `ALTER TABLE products ADD COLUMN price_cents INTEGER;

UPDATE products SET price_cents = round(price * 100)::int WHERE price_cents IS NULL;

-- Old (v1) and new (v2) app versions write different columns during the
-- rollout, so a trigger keeps both in sync.
CREATE FUNCTION sync_product_price() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.price_cents := COALESCE(NEW.price_cents, round(NEW.price * 100)::int);
    NEW.price := COALESCE(NEW.price, NEW.price_cents / 100.0);
  ELSIF NEW.price IS DISTINCT FROM OLD.price THEN
    NEW.price_cents := round(NEW.price * 100)::int;
  ELSIF NEW.price_cents IS DISTINCT FROM OLD.price_cents THEN
    NEW.price := NEW.price_cents / 100.0;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_sync_product_price
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION sync_product_price();`,
        down: `DROP TRIGGER IF EXISTS trg_sync_product_price ON products;
DROP FUNCTION IF EXISTS sync_product_price();
ALTER TABLE products DROP COLUMN IF EXISTS price_cents;`,
      },
      {
        version: 3,
        description: 'Migrate: enforce price_cents now that it is backfilled',
        phase: 'migrate',
        up: `ALTER TABLE products ADD CONSTRAINT chk_price_cents_non_negative CHECK (price_cents >= 0) NOT VALID;
ALTER TABLE products VALIDATE CONSTRAINT chk_price_cents_non_negative;
ALTER TABLE products ALTER COLUMN price_cents SET NOT NULL;`,
        down: `ALTER TABLE products ALTER COLUMN price_cents DROP NOT NULL;
ALTER TABLE products DROP CONSTRAINT IF EXISTS chk_price_cents_non_negative;`,
      },
      {
        version: 4,
        description: 'Rename name to title (direct, unsafe)',
        phase: 'standard',
        up: `ALTER TABLE products RENAME COLUMN name TO title;`,
        down: `ALTER TABLE products RENAME COLUMN title TO name;`,
      },
      {
        version: 5,
        description: 'Contract: drop legacy price column',
        phase: 'contract',
        up: `DROP TRIGGER IF EXISTS trg_sync_product_price ON products;
DROP FUNCTION IF EXISTS sync_product_price();
ALTER TABLE products DROP COLUMN price;`,
        down: `-- Best-effort reversal: the old column is recreated from price_cents.
ALTER TABLE products ADD COLUMN price NUMERIC(10,2);
UPDATE products SET price = price_cents / 100.0;`,
      },
    ],
  },
  {
    slug: 'order_service',
    name: 'Order Service',
    description: 'Orders microservice. Demonstrates a non-transactional index, a failed migration and a health-check rollback.',
    primary_table: 'orders',
    apps: [
      { version: 'v1.0', requires: { orders: ['id', 'product_sku', 'quantity', 'status'] } },
    ],
    scripts: [
      {
        version: 1,
        description: 'Create orders table',
        phase: 'standard',
        up: `CREATE TABLE orders (
  id           SERIAL PRIMARY KEY,
  product_sku  VARCHAR(32) NOT NULL,
  quantity     INTEGER NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'NEW',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Row 4 is a legacy placeholder order with quantity 0.
INSERT INTO orders (product_sku, quantity, status) VALUES
  ('KB-101', 2, 'PAID'),
  ('MS-220', 1, 'SHIPPED'),
  ('HD-330', 3, 'NEW'),
  ('MN-440', 0, 'NEW'),
  ('CB-550', 5, 'PAID');`,
        down: `DROP TABLE orders;`,
      },
      {
        version: 2,
        description: 'Index orders by status (concurrently)',
        phase: 'standard',
        up: `CREATE INDEX CONCURRENTLY idx_orders_status ON orders (status);`,
        down: `DROP INDEX CONCURRENTLY IF EXISTS idx_orders_status;`,
      },
      {
        version: 3,
        description: 'Require positive quantity',
        phase: 'standard',
        up: `ALTER TABLE orders ADD CONSTRAINT chk_orders_quantity_positive CHECK (quantity > 0);`,
        down: `ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_quantity_positive;`,
      },
      {
        version: 4,
        description: 'Fix legacy rows, then require positive quantity',
        phase: 'standard',
        up: `UPDATE orders SET quantity = 1, status = 'CANCELLED' WHERE quantity <= 0;
ALTER TABLE orders ADD CONSTRAINT chk_orders_quantity_positive CHECK (quantity > 0) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT chk_orders_quantity_positive;`,
        down: `ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_quantity_positive;`,
      },
      {
        version: 5,
        description: 'Tool-generated cleanup of status column',
        phase: 'standard',
        up: `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'orders' AND column_name = 'status') THEN
    EXECUTE 'ALTER TABLE orders RENAME COLUMN status TO order_status';
  END IF;
END $$;`,
        down: `ALTER TABLE orders RENAME COLUMN order_status TO status;`,
      },
    ],
  },
];
