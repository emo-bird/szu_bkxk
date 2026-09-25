/**
 * 悬浮窗样式（字符串形式注入，见 src/ui/panel.js）。
 *
 * 【隔离策略】类名统一加 `szubkxk-` 前缀 + 只在自己的根节点内做局部 reset，
 * 不引入 shadow DOM（那样站点自带库的主题 CSS 进不来，与"复用站点库"的目标冲突）。
 * 详见 docs/方案-油猴脚本.md §6.1 的取舍说明。
 *
 * @param {object} root 全局对象
 */
(function (root) {
  'use strict';

  var NS = (root.SZUBKXK = root.SZUBKXK || {});
  var UI = (NS.ui = NS.ui || {});
  var ST = (UI.styles = UI.styles || {});

  /** 样式节点的 id，用于幂等注入（页面刷新/重复注入不会叠加多份）。 */
  ST.STYLE_ID = 'szubkxk-style';

  ST.CSS = [
    '.szubkxk-root{position:fixed;z-index:2147483000;width:380px;max-height:70vh;display:flex;flex-direction:column;',
    'background:#fff;color:#222;border:1px solid #d0d0d0;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.18);',
    'font:12px/1.6 "Microsoft YaHei",Arial,sans-serif;box-sizing:border-box;text-align:left;}',
    '.szubkxk-root *{box-sizing:border-box;font-family:inherit;}',
    '.szubkxk-header{display:flex;align-items:center;gap:6px;padding:6px 10px;background:#1a5fb4;color:#fff;',
    'border-radius:7px 7px 0 0;cursor:move;user-select:none;}',
    '.szubkxk-title{font-weight:700;font-size:13px;}',
    '.szubkxk-version{opacity:.8;font-size:11px;}',
    '.szubkxk-spacer{flex:1;}',
    '.szubkxk-hbtn{border:0;background:rgba(255,255,255,.15);color:#fff;width:22px;height:20px;border-radius:4px;',
    'cursor:pointer;font-size:12px;line-height:1;padding:0;}',
    '.szubkxk-hbtn:hover{background:rgba(255,255,255,.3);}',
    '.szubkxk-body{overflow:auto;padding:8px 10px;}',
    '.szubkxk-root[data-collapsed="true"] .szubkxk-body{display:none;}',
    '.szubkxk-sec{margin-bottom:10px;border-bottom:1px dashed #e0e0e0;padding-bottom:8px;}',
    '.szubkxk-sec:last-child{border-bottom:0;margin-bottom:0;}',
    '.szubkxk-sec-title{font-weight:700;color:#1a5fb4;margin-bottom:4px;}',
    '.szubkxk-row{display:flex;align-items:center;gap:6px;margin:3px 0;flex-wrap:wrap;}',
    '.szubkxk-muted{color:#777;}',
    '.szubkxk-warn{color:#b00020;}',
    '.szubkxk-ok{color:#1a7f37;}',
    '.szubkxk-input{width:74px;padding:2px 4px;border:1px solid #ccc;border-radius:4px;font-size:12px;}',
    '.szubkxk-btn{border:1px solid #ccc;background:#f6f6f6;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:12px;}',
    '.szubkxk-btn:hover{background:#ececec;}',
    '.szubkxk-danger{border-color:#e0b4b4;background:#fff5f5;color:#b00020;}',
    '.szubkxk-logs{max-height:190px;overflow:auto;background:#fafafa;border:1px solid #eee;border-radius:4px;padding:4px;}',
    '.szubkxk-log{white-space:pre-wrap;word-break:break-all;border-bottom:1px solid #f0f0f0;padding:2px 0;}',
    '.szubkxk-log[data-level="error"]{color:#b00020;}',
    '.szubkxk-log[data-level="warn"]{color:#a06000;}',
    '.szubkxk-log-unknown{background:#fff4e5;font-weight:700;}',
    '.szubkxk-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px;}',
    '.szubkxk-filters label{display:flex;align-items:center;gap:2px;font-size:11px;cursor:pointer;}',
    '.szubkxk-launcher{position:fixed;right:14px;bottom:14px;z-index:2147483000;border:0;border-radius:16px;',
    'padding:6px 12px;background:#1a5fb4;color:#fff;cursor:pointer;font:12px "Microsoft YaHei",Arial,sans-serif;',
    'box-shadow:0 4px 14px rgba(0,0,0,.25);}',
    '.szubkxk-form{background:#f7f9fc;border:1px solid #e3e9f2;border-radius:4px;padding:6px;margin:4px 0;}',
    '.szubkxk-input-wide{width:150px;}',
    '.szubkxk-textarea{width:100%;font:12px "Microsoft YaHei",Arial,sans-serif;border:1px solid #ccc;',
    'border-radius:4px;padding:3px;box-sizing:border-box;}',
    '.szubkxk-tasks{max-height:180px;overflow:auto;border:1px solid #eee;border-radius:4px;}',
    '.szubkxk-task{padding:4px 6px;border-bottom:1px solid #f0f0f0;}',
    '.szubkxk-task:last-child{border-bottom:0;}',
    '.szubkxk-task-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
    '.szubkxk-task-name{font-weight:700;}',
    '.szubkxk-hidden{display:none !important;}',
  ].join('');

  /**
   * 幂等注入样式表。
   * @param {Document} doc 目标文档
   * @returns {Element|null} 样式节点
   */
  ST.inject = function (doc) {
    if (!doc) return null;
    var existing = doc.getElementById(ST.STYLE_ID);
    if (existing) return existing;
    var style = doc.createElement('style');
    style.id = ST.STYLE_ID;
    style.type = 'text/css';
    style.textContent = ST.CSS;
    (doc.head || doc.documentElement).appendChild(style);
    return style;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
