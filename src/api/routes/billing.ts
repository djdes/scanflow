import express, { Router, Request, Response } from 'express';
import { getBillingOverview } from '../../billing/catalog';
import { PaymentsDisabledError, robokassaGateway } from '../../billing/robokassa/gateway';

const router = Router();
function requireUser(req: Request, res: Response): boolean {
  if (!req.user) { res.status(401).json({ error: 'Authentication required' }); return false; }
  return true;
}

router.get('/', (req: Request, res: Response) => {
  if (!requireUser(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: getBillingOverview(req.user) });
});

router.post('/checkout', (req: Request, res: Response) => {
  if (!requireUser(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  try { robokassaGateway.createCheckout(); } catch (error) {
    if (error instanceof PaymentsDisabledError) {
      res.status(503).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
});

// Public browser/server return routes. They stay mounted before apiKeyAuth, but
// never acknowledge ResultURL or mark anything paid while payments are disabled.
export const robokassaCallbackRouter = Router();
robokassaCallbackRouter.use(express.urlencoded({ extended: false }));
robokassaCallbackRouter.all('/result', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  try { robokassaGateway.acceptResult(); } catch (error) {
    if (error instanceof PaymentsDisabledError) {
      res.status(503).type('text/plain').send(error.code);
      return;
    }
    throw error;
  }
});
robokassaCallbackRouter.all('/success', (_req: Request, res: Response) => res.redirect(303, '/app.html#/billing?payment=returned'));
robokassaCallbackRouter.all('/fail', (_req: Request, res: Response) => res.redirect(303, '/app.html#/billing?payment=cancelled'));

export default router;
