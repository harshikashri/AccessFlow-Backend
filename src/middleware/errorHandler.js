import { AppError } from '../utils/AppError.js';

export const notFoundHandler = (req, res, next) => {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404, 'NOT_FOUND'));
};

export const errorHandler = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  let statusCode = err.statusCode || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.isOperational ? err.message : 'An unexpected error occurred.';
  let details = err.isOperational ? err.details : undefined;

  if (err.name === 'ValidationError') {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed.';
    details = Object.values(err.errors || {}).map((item) => item.message);
  } else if (err.name === 'CastError') {
    statusCode = 400;
    code = 'INVALID_ID';
    message = 'Invalid identifier provided.';
  } else if (err.code === 11000) {
    statusCode = 409;
    code = 'DUPLICATE_KEY';
    message = 'A record with the same unique value already exists.';
  }

  if (statusCode >= 500) {
    console.error('Unhandled error:', err);
  }

  const payload = {
    success: false,
    message,
    code,
  };

  if (details !== undefined) {
    payload.details = details;
  }

  return res.status(statusCode).json(payload);
};

export default errorHandler;
