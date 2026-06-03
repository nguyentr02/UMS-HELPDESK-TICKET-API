-- Two simplifications driven by feedback:
-- 1. RoutingRule (category → department mapping with isDefault flag) gets
--    dropped entirely. In practice agents/leads pick department independently
--    when forwarding; the auto-preselect was over-modelling and caused
--    friction for cross-domain tickets (e.g. tài chính that also needs IT).
-- 2. Category.parentId / hierarchical categories get flattened. The 2-level
--    taxonomy was never exercised; everything is a leaf in practice.

BEGIN;

-- Drop the routing_rules table along with its constraints/indexes.
DROP TABLE IF EXISTS "routing_rules";

-- Flatten categories: drop the parent FK + unique-with-parent + parent index.
ALTER TABLE "categories" DROP CONSTRAINT IF EXISTS "categories_parentId_fkey";
DROP INDEX IF EXISTS "categories_name_parentId_key";
DROP INDEX IF EXISTS "categories_parentId_idx";
ALTER TABLE "categories" DROP COLUMN IF EXISTS "parentId";

COMMIT;
