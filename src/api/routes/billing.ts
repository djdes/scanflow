import { Router, type Request, type Response } from 'express';
import { getBillingOverview } from '../../billing/catalog';
import { PaymentsDisabledError, robokassaGateway } from '../../billing/robokassa/gateway';

const router = Router();
router.use((req: Request, res: Response, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
});
router.get('/', (_req, res) => res.json({ data: getBillingOverview() }));
router.post('/checkout', (_req, res) => {
  try { robokassaGateway.createCheckout(); }
  catch (error) {
    if (!(error instanceof PaymentsDisabledError)) throw error;
    return res.status(503).json({ code: error.code, error: error.message });
  }
});
export default router;

// Reserved public provider endpoints. No body/query data is trusted, persisted,
// or echoed; callbacks never return OK{InvId} while settlement is disabled.
export const robokassaCallbackRouter = Router();
robokassaCallbackRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
robokassaCallbackRouter.route('/result').get(disabledResult).post(disabledResult);
function disabledResult(_req: Request, res: Response) {
  try { robokassaGateway.acceptResult(); }
  catch (error) {
    if (!(error instanceof PaymentsDisabledError)) throw error;
    return res.status(503).type('text/plain').send(error.code);
  }
}
for (const [path, state] of [['/success', 'returned'], ['/fail', 'cancelled']]) {
  const redirect = (_req: Request, res: Response) => res.redirect(303, `/app.html#/billing?payment=${state}`);
  robokassaCallbackRouter.route(path).get(redirect).post(redirect);
}
