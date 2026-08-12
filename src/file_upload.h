#ifndef TTYD_FILE_UPLOAD_H
#define TTYD_FILE_UPLOAD_H

#include <stddef.h>
#include <uv.h>

#define FILE_UPLOAD_PATH_MAX 1024

// Longest filename suffix carried over from the browser. Long enough for real
// documents, short enough that the stored path still fits comfortably in a
// terminal line the user has to read.
#define FILE_UPLOAD_NAME_MAX 96

typedef struct file_upload_req file_upload_req;

// `status` is 0 on success and a negative libuv error code on failure. `path`
// is the absolute path of the stored file on success; `error` is populated on
// failure. Both strings are owned by the request and are valid only during the
// callback.
typedef void (*file_upload_done_cb)(void *ctx, int status, const char *path, const char *error);

// Store uploaded bytes in the host's temporary directory without blocking the
// libwebsockets/libuv event loop. Ownership of `data` passes to this function.
// `name` is the browser's filename, used only to give the stored file a
// recognisable name and extension; it is sanitised here and may be NULL or
// empty. The caller may detach while the worker is running; the upload still
// finishes but no callback is made.
file_upload_req *file_upload_store(uv_loop_t *loop, char *data, size_t len, const char *name, file_upload_done_cb cb,
                                   void *ctx, int *err);

void file_upload_detach(file_upload_req *req);

#endif
