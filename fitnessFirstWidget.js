async function loadWidgetScript() {
  const SOURCE_URL =
    "https://raw.githubusercontent.com/jesperschlegel/FitnessFirstWidget/refs/heads/main/src/widget.js"

  const fm = FileManager.local()
  const cacheDir = fm.joinPath(fm.documentsDirectory(), "fitnessfirst-widget-cache")
  const sourceFile = fm.joinPath(cacheDir, "widget.js")
  const metaFile = fm.joinPath(cacheDir, "widget.meta.json")

  if (!fm.fileExists(cacheDir)) {
    fm.createDirectory(cacheDir)
  }

  let meta = {}
  if (fm.fileExists(metaFile)) {
    try {
      meta = JSON.parse(fm.readString(metaFile))
    } catch (_) {}
  }

  try {
    const req = new Request(SOURCE_URL)
    req.method = "GET"

    if (meta.etag) {
      req.headers["If-None-Match"] = meta.etag
    }
    if (meta.lastModified) {
      req.headers["If-Modified-Since"] = meta.lastModified
    }

    const res = await req.load()
    const status = req.response.statusCode

    if (status === 304 && fm.fileExists(sourceFile)) {
      return fm.readString(sourceFile)
    }

    if (status === 200) {
      const jsSource = res.toRawString()

      fm.writeString(sourceFile, jsSource)
      fm.writeString(
        metaFile,
        JSON.stringify({
          etag: req.response.headers["ETag"],
          lastModified: req.response.headers["Last-Modified"]
        })
      )

      return jsSource
    }

    throw new Error(`Unexpected status code: ${status}`)
  } catch (err) {
    if (fm.fileExists(sourceFile)) {
      return fm.readString(sourceFile)
    }

    throw err
  }
}

const jsSource = await loadWidgetScript()
eval(`(async () => { ${jsSource} })()`)
