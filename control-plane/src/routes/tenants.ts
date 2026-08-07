// control-plane/src/routes/tenants.ts
import { Router } from 'express';
import { ok } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { authMiddleware } from '../middleware/auth.js';
import { isPlatformStaff } from '../lib/platformStaff.js';
import * as tenantRepo from '../domains/tenant/tenantRepository.js';

const router = Router();
router.use(authMiddleware);

/**
 * GET /v1/tenants — platform staff (OIDC isStaff or admin:read API key) see
 * all tenants. OIDC members see the tenants they belong to; an API key sees
 * its own tenant. (Membership-scoped; staff: all tenants.)
 */
router.get(
  '/',
  defineHandler({
    async handler(req, res) {
      const user = req.user;
      let items: tenantRepo.TenantRow[];
      if (isPlatformStaff(user)) {
        items = await tenantRepo.listTenants();
      } else if (user?.type === 'oidc' && user.userId) {
        items = await tenantRepo.listTenantsForUser(user.userId);
      } else if (user?.tenantId) {
        const own = await tenantRepo.getTenantById(user.tenantId);
        items = own ? [own] : [];
      } else {
        items = [];
      }
      ok(res, { items });
    },
  })
);

export default router;
