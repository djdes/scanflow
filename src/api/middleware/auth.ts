import { Request, Response, NextFunction } from 'express';
import { config } from '../../config';

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = (req.headers['x-api-key'] as string) || (req.query.key as string);

  if (!apiKey || apiKey !== config.apiKey) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
    return;
  }

  next();
}
