class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function errorHandler(error, request, response, next) {
  if (response.headersSent) {
    response.destroy(error);
    return;
  }

  if (error instanceof ApiError) {
    response.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }

  if (error instanceof require('multer').MulterError) {
    const isTooLarge = error.code === 'LIMIT_FILE_SIZE';
    response.status(isTooLarge ? 413 : 400).json({
      error: {
        code: isTooLarge ? 'FILE_TOO_LARGE' : 'INVALID_UPLOAD',
        message: isTooLarge
          ? 'The uploaded file exceeds the permitted size.'
          : 'Upload exactly one file using the field name "file".',
      },
    });
    return;
  }

  response.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred.',
    },
  });
}

module.exports = { ApiError, errorHandler };