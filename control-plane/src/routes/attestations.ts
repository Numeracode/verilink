import { Router } from 'express';
import { ok, created } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import { AppError, CODES } from '../shared/errors/AppError.js';
import * as attestationService from '../domains/attestation/attestationService.js';

const router = Router();
router.use(authMiddleware);

router.post('/submit', requireScope('attest:write'), defineHandler({
  async handler(req, res) {
    const { token } = req.body;
    if (!token || typeof token !== 'string') {
      throw new AppError(CODES.BAD_REQUEST, 'Missing required field: token');
    }
    const att = await attestationService.submitAttestation({ jwsToken: token });
    created(res, att);
  },
}));

router.get('/', requireScope('attest:read'), defineHandler({
  query: {
    issuer_id: { type: 'string' },
    subject_id: { type: 'string' },
    limit: { type: 'number', min: 1, max: 200 },
    offset: { type: 'number', min: 0 },
  },
  async handler(req, res) {
    const tenantIds = req.user?.tenantIds || (req.user?.tenantId ? [req.user.tenantId] : []);
    const roles = req.user?.roles || [];
    const callerTenantIds = roles.length > 0
      ? tenantIds.filter((_, i) => roles[i] === 'staff' || roles[i] === 'admin')
      : tenantIds;
    const result = await attestationService.listAttestations({
      issuerId: req.query.issuer_id as string,
      subjectId: req.query.subject_id as string,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
      callerTenantIds,
      isStaff: req.user?.isStaff || false,
    });
    ok(res, result);
  },
}));

export default router;