#include "image_upload.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "utils.h"

#define IMAGE_UPLOAD_PREFIX "ttyd-image-paste-"
#define IMAGE_CURRENT_PREFIX "ttyd-image-current-"
#define IMAGE_UPLOAD_TTL_SECONDS (24 * 60 * 60)

struct image_upload_req {
  uv_work_t work;
  char *data;
  size_t len;
  image_upload_done_cb cb;
  void *ctx;
  int status;
  char path[IMAGE_UPLOAD_PATH_MAX];
  char error[160];
};

static char path_separator(const char *dir) {
  size_t len = strlen(dir);
  if (len > 0 && (dir[len - 1] == '/' || dir[len - 1] == '\\')) return '\0';
#ifdef _WIN32
  return '\\';
#else
  return '/';
#endif
}

static bool join_path(char *out, size_t out_len, const char *dir, const char *name) {
  char separator = path_separator(dir);
  int written = separator == '\0' ? snprintf(out, out_len, "%s%s", dir, name)
                                  : snprintf(out, out_len, "%s%c%s", dir, separator, name);
  return written >= 0 && (size_t)written < out_len;
}

static int write_all(int file, const char *data, size_t len) {
  size_t offset = 0;
  while (offset < len) {
    uv_buf_t buf = uv_buf_init((char *)data + offset, (unsigned int)(len - offset));
    uv_fs_t write_req;
    int written = uv_fs_write(NULL, &write_req, file, &buf, 1, -1, NULL);
    uv_fs_req_cleanup(&write_req);
    if (written < 0) return written;
    if (written == 0) return UV_EIO;
    offset += (size_t)written;
  }
  return 0;
}

// Keep the compatibility pointer for browser tabs that still have the old UI
// loaded. New clients use the returned path directly; stale clients can keep
// using the X11-free xclip helper until their next page refresh.
static int publish_current_upload(const char *temp_dir, const char *image_path, char *error, size_t error_len) {
  uv_passwd_t passwd;
  int status = uv_os_get_passwd(&passwd);
  if (status != 0) {
    snprintf(error, error_len, "identify upload owner: %s", uv_strerror(status));
    return status;
  }

  char current_name[96];
  char staging_name[112];
  snprintf(current_name, sizeof(current_name), IMAGE_CURRENT_PREFIX "%llu", (unsigned long long)passwd.uid);
  snprintf(staging_name, sizeof(staging_name), "%s-XXXXXX", current_name);
  uv_os_free_passwd(&passwd);

  char current_path[IMAGE_UPLOAD_PATH_MAX];
  char staging_path[IMAGE_UPLOAD_PATH_MAX];
  if (!join_path(current_path, sizeof(current_path), temp_dir, current_name) ||
      !join_path(staging_path, sizeof(staging_path), temp_dir, staging_name)) {
    snprintf(error, error_len, "current image path is too long");
    return UV_ENAMETOOLONG;
  }

  uv_fs_t open_req;
  int file = uv_fs_mkstemp(NULL, &open_req, staging_path, NULL);
  if (file < 0) {
    snprintf(error, error_len, "create current image pointer: %s", uv_strerror(file));
    uv_fs_req_cleanup(&open_req);
    return file;
  }
  char generated_path[IMAGE_UPLOAD_PATH_MAX];
  snprintf(generated_path, sizeof(generated_path), "%s", open_req.path);
  uv_fs_req_cleanup(&open_req);

  char contents[IMAGE_UPLOAD_PATH_MAX + 2];
  int contents_len = snprintf(contents, sizeof(contents), "%s\n", image_path);
  status = contents_len < 0 || (size_t)contents_len >= sizeof(contents)
               ? UV_ENAMETOOLONG
               : write_all(file, contents, (size_t)contents_len);
  if (status == 0) {
    uv_fs_t sync_req;
    status = uv_fs_fsync(NULL, &sync_req, file, NULL);
    uv_fs_req_cleanup(&sync_req);
  }

  uv_fs_t close_req;
  int close_status = uv_fs_close(NULL, &close_req, file, NULL);
  uv_fs_req_cleanup(&close_req);
  if (status == 0 && close_status < 0) status = close_status;

  if (status == 0) {
    uv_fs_t rename_req;
    status = uv_fs_rename(NULL, &rename_req, generated_path, current_path, NULL);
    uv_fs_req_cleanup(&rename_req);
  }

  if (status != 0) {
    uv_fs_t unlink_req;
    uv_fs_unlink(NULL, &unlink_req, generated_path, NULL);
    uv_fs_req_cleanup(&unlink_req);
    snprintf(error, error_len, "publish current image: %s", uv_strerror(status));
  }
  return status;
}

// Best-effort cleanup keeps abandoned uploads bounded without a resident timer
// or a clipboard-owner process. A file stays for a day so queued/draft image
// attachments and short-lived reconnects can still resolve it.
static void cleanup_old_uploads(const char *temp_dir) {
  uv_fs_t scan;
  int count = uv_fs_scandir(NULL, &scan, temp_dir, 0, NULL);
  if (count < 0) return;

  time_t cutoff = time(NULL) - IMAGE_UPLOAD_TTL_SECONDS;
  uv_dirent_t entry;
  while (uv_fs_scandir_next(&scan, &entry) == 0) {
    if (strncmp(entry.name, IMAGE_UPLOAD_PREFIX, strlen(IMAGE_UPLOAD_PREFIX)) != 0) continue;

    char path[IMAGE_UPLOAD_PATH_MAX];
    if (!join_path(path, sizeof(path), temp_dir, entry.name)) continue;

    uv_fs_t stat_req;
    int status = uv_fs_stat(NULL, &stat_req, path, NULL);
    if (status == 0 && stat_req.statbuf.st_mtim.tv_sec < cutoff) {
      uv_fs_t unlink_req;
      uv_fs_unlink(NULL, &unlink_req, path, NULL);
      uv_fs_req_cleanup(&unlink_req);
    }
    uv_fs_req_cleanup(&stat_req);
  }
  uv_fs_req_cleanup(&scan);
}

static void store_work(uv_work_t *work) {
  image_upload_req *req = (image_upload_req *)work->data;
  char temp_dir[IMAGE_UPLOAD_PATH_MAX];
  size_t temp_dir_len = sizeof(temp_dir);

  req->status = uv_os_tmpdir(temp_dir, &temp_dir_len);
  if (req->status != 0) {
    snprintf(req->error, sizeof(req->error), "find temporary directory: %s", uv_strerror(req->status));
    return;
  }

  cleanup_old_uploads(temp_dir);
  if (!join_path(req->path, sizeof(req->path), temp_dir, IMAGE_UPLOAD_PREFIX "XXXXXX")) {
    req->status = UV_ENAMETOOLONG;
    snprintf(req->error, sizeof(req->error), "temporary image path is too long");
    return;
  }

  uv_fs_t open_req;
  int file = uv_fs_mkstemp(NULL, &open_req, req->path, NULL);
  if (file < 0) {
    req->status = file;
    snprintf(req->error, sizeof(req->error), "create temporary image: %s", uv_strerror(file));
    uv_fs_req_cleanup(&open_req);
    return;
  }
  char generated_path[IMAGE_UPLOAD_PATH_MAX];
  snprintf(generated_path, sizeof(generated_path), "%s", open_req.path);
  uv_fs_req_cleanup(&open_req);
  snprintf(req->path, sizeof(req->path), "%s", generated_path);

  req->status = write_all(file, req->data, req->len);
  if (req->status != 0)
    snprintf(req->error, sizeof(req->error), "write temporary image: %s", uv_strerror(req->status));

  if (req->status == 0) {
    uv_fs_t sync_req;
    int status = uv_fs_fsync(NULL, &sync_req, file, NULL);
    uv_fs_req_cleanup(&sync_req);
    if (status < 0) {
      req->status = status;
      snprintf(req->error, sizeof(req->error), "sync temporary image: %s", uv_strerror(status));
    }
  }

  uv_fs_t close_req;
  int close_status = uv_fs_close(NULL, &close_req, file, NULL);
  uv_fs_req_cleanup(&close_req);
  if (req->status == 0 && close_status < 0) {
    req->status = close_status;
    snprintf(req->error, sizeof(req->error), "close temporary image: %s", uv_strerror(close_status));
  }

  if (req->status == 0)
    req->status = publish_current_upload(temp_dir, req->path, req->error, sizeof(req->error));

  if (req->status != 0) {
    uv_fs_t unlink_req;
    uv_fs_unlink(NULL, &unlink_req, req->path, NULL);
    uv_fs_req_cleanup(&unlink_req);
    req->path[0] = '\0';
  }
}

static void store_done(uv_work_t *work, int status) {
  image_upload_req *req = (image_upload_req *)work->data;
  if (status != 0 && req->status == 0) {
    req->status = status;
    snprintf(req->error, sizeof(req->error), "store temporary image: %s", uv_strerror(status));
  }

  if (req->cb != NULL)
    req->cb(req->ctx, req->status, req->status == 0 ? req->path : NULL,
            req->status == 0 ? NULL : req->error);

  free(req->data);
  free(req);
}

image_upload_req *image_upload_store(uv_loop_t *loop, char *data, size_t len, image_upload_done_cb cb, void *ctx,
                                     int *err) {
  image_upload_req *req = xmalloc(sizeof(image_upload_req));
  memset(req, 0, sizeof(image_upload_req));
  req->work.data = req;
  req->data = data;
  req->len = len;
  req->cb = cb;
  req->ctx = ctx;

  int status = uv_queue_work(loop, &req->work, store_work, store_done);
  if (status != 0) {
    *err = status;
    free(data);
    free(req);
    return NULL;
  }
  return req;
}

void image_upload_detach(image_upload_req *req) {
  if (req == NULL) return;
  req->cb = NULL;
  req->ctx = NULL;
}
