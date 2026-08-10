#ifndef TTYD_IMAGE_UPLOAD_H
#define TTYD_IMAGE_UPLOAD_H

#include <stddef.h>
#include <uv.h>

#define IMAGE_UPLOAD_PATH_MAX 1024

typedef struct image_upload_req image_upload_req;

// `status` is 0 on success and a negative libuv error code on failure. `path`
// is the absolute path of the stored image on success; `error` is populated on
// failure. Both strings are owned by the request and are valid only during the
// callback.
typedef void (*image_upload_done_cb)(void *ctx, int status, const char *path, const char *error);

// Store PNG bytes in the host's temporary directory without blocking the
// libwebsockets/libuv event loop. Ownership of `data` passes to this function.
// The caller may detach while the worker is running; the upload still finishes
// but no callback is made.
image_upload_req *image_upload_store(uv_loop_t *loop, char *data, size_t len, image_upload_done_cb cb, void *ctx,
                                     int *err);

void image_upload_detach(image_upload_req *req);

#endif
