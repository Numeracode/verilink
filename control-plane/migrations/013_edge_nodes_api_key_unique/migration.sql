-- One edge node per API key (when api_key_id is set). Deduplicate before index.

WITH ranked AS (
  SELECT
    id,
    tenant_id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, api_key_id
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM edge_nodes
  WHERE api_key_id IS NOT NULL
),
dups AS (
  SELECT id, tenant_id FROM ranked WHERE rn > 1
)
DELETE FROM sync_cursors sc
USING dups d
WHERE sc.tenant_id = d.tenant_id AND sc.edge_node_id = d.id;

WITH ranked AS (
  SELECT
    id,
    tenant_id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, api_key_id
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM edge_nodes
  WHERE api_key_id IS NOT NULL
),
dups AS (
  SELECT id, tenant_id FROM ranked WHERE rn > 1
)
DELETE FROM decision_aggregates da
USING dups d
WHERE da.tenant_id = d.tenant_id AND da.edge_node_id = d.id;

WITH ranked AS (
  SELECT
    id,
    tenant_id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, api_key_id
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM edge_nodes
  WHERE api_key_id IS NOT NULL
),
dups AS (
  SELECT id, tenant_id FROM ranked WHERE rn > 1
)
DELETE FROM decision_samples ds
USING dups d
WHERE ds.tenant_id = d.tenant_id AND ds.edge_node_id = d.id;

WITH ranked AS (
  SELECT
    id,
    tenant_id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, api_key_id
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM edge_nodes
  WHERE api_key_id IS NOT NULL
),
dups AS (
  SELECT id, tenant_id FROM ranked WHERE rn > 1
)
DELETE FROM decision_batches db
USING dups d
WHERE db.tenant_id = d.tenant_id AND db.edge_node_id = d.id;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, api_key_id
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM edge_nodes
  WHERE api_key_id IS NOT NULL
)
DELETE FROM edge_nodes e
USING ranked r
WHERE e.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX edge_nodes_tenant_api_key_unique
  ON edge_nodes (tenant_id, api_key_id)
  WHERE api_key_id IS NOT NULL;
