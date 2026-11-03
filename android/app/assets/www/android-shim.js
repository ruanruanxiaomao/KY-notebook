/* 安卓壳专用补丁：网页里点「PNG / JSON」时，把 Blob 交给原生存到「下载/KY-notebook/」。
   浏览器里没有 KYNative，这个文件不会产生任何效果。 */
(function () {
  if (!window.KYNative || typeof window.KYNative.saveFile !== 'function') return;
  var origClick = HTMLAnchorElement.prototype.click;
  function b64(buf) {
    var bytes = new Uint8Array(buf), bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }
  HTMLAnchorElement.prototype.click = function () {
    var name = this.getAttribute('download');
    var href = this.getAttribute('href') || '';
    if (!name || !/^(blob:|data:)/.test(href)) return origClick.call(this);
    fetch(href).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
      var where = window.KYNative.saveFile(name, b64(buf));
      if (window.KYNative.toast) window.KYNative.toast(where.indexOf('ERR') === 0 ? ('保存失败：' + where) : ('已保存：' + where));
    }).catch(function (e) {
      if (window.KYNative.toast) window.KYNative.toast('保存失败：' + e.message);
    });
    return undefined;
  };
})();
