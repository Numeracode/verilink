import { Router } from 'express';
import { ok, created } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { authMiddleware } from '../middleware/auth.js';
import * as attestationService from '../domains/attestation/attestationService.js';

const router = Router();
router.use(authMiddleware);

router.post('/submit', defineHandler({
  async handler(req, res) {
    const { token, verified } = req.body;
    // In v1, the caller provides the verified payload (from trust-engine gRPC)
    // In production, the control plane would call trust-engine.VerifyAttestation
    const att = await attestationService.submitAttestation({
      jwsToken: token,
      verified,
    });
    created(res, att);
  },
}));

router.get('/', defineHandler({
  query: {
    issuer_id: { type: 'string' },
    subject_id: { type: 'string' },
    limit: { type: 'number', min: 1, max: 200 },
    offset: { type: 'number', min: 0 },
  },
  async handler(req, res) {
    const result = await attestationService.listAttestations({
      issuerId: req.query.issuer_id as string,
      subjectId: req.query.subject_id as string,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    });
    ok(res, result);
  },
}));

export default router;
