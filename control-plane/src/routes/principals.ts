import { Router } from 'express';
import { ok, created } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { authMiddleware } from '../middleware/auth.js';
import * as principalService from '../domains/principal/principalService.js';

const authMw = authMiddleware;
const router = Router();
router.use(authMw);

router.get('/', defineHandler({
  query: {
    entity_kind: { type: 'string', enum: ['agent', 'issuer', 'both'] },
    limit: { type: 'number', min: 1, max: 200 },
    offset: { type: 'number', min: 0 },
  },
  async handler(req, res) {
    const result = await principalService.listPrincipals({
      tenantId: req.user?.tenantId || undefined,
      entityKind: req.query.entity_kind as string,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    });
    ok(res, result);
  },
}));

router.post('/', defineHandler({
  async handler(req, res) {
    const { entity_kind, name } = req.body;
    const principal = await principalService.createPrincipal({
      entityKind: entity_kind,
      ownerTenantId: req.user?.tenantId || undefined,
      name,
    });
    created(res, principal, `/v1/principals/${principal.id}`);
  },
}));

router.get('/:id', defineHandler({
  params: { id: { type: 'string' } },
  async handler(req, res) {
    const principal = await principalService.getPrincipal(req.params.id as string);
    ok(res, principal);
  },
}));

router.post('/:id/keys', defineHandler({
  params: { id: { type: 'string' } },
  async handler(req, res) {
    const { key_id, public_key_raw, public_key_jwk, key_hash } = req.body;
    const key = await principalService.addKey(
      req.params.id as string,
      key_id,
      Buffer.from(public_key_raw, 'base64'),
      public_key_jwk,
      key_hash
    );
    created(res, key);
  },
}));

router.get('/:id/keys', defineHandler({
  params: { id: { type: 'string' } },
  async handler(req, res) {
    const keys = await principalService.listKeys(req.params.id as string);
    ok(res, keys);
  },
}));

export default router;
