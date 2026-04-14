export function buildDraftCreatedMessage({ openUrl, scriptLoaded }) {
  if (scriptLoaded) {
    return [
      '视频入口已创建。',
      '打开链接后文案已自动填好，其他参数可继续修改，并手动点击生成：',
      openUrl,
    ].join('\n');
  }

  return [
    '视频入口已创建。',
    '打开链接后请先填写文案，其他参数也可继续修改，并手动点击生成：',
    openUrl,
  ].join('\n');
}

export function buildDraftCreateFailedMessage() {
  return '生成入口创建失败，请稍后重试';
}

export function buildHandleCommandInvalidMessage() {
  return '参数格式错误，请使用 /handle <群ID> <文案路径或URL>';
}

export function buildManualWebsiteEntryMessage({ websiteUrl }) {
  return [
    '视频生成入口：',
    websiteUrl,
    '',
    '打开链接后请填写文案，调整参数后手动点击生成。',
  ].join('\n');
}

export function buildCallbackCompletedMessage({ videoUrl, jobPageUrl }) {
  return [
    '视频已生成完成',
    `下载：${videoUrl}`,
    `详情：${jobPageUrl}`,
  ].join('\n');
}

export function buildCallbackFailedMessage({ jobPageUrl, error }) {
  const lines = [
    '视频生成失败',
    `详情：${jobPageUrl}`,
  ];
  if (error) {
    lines.push(error);
  }
  return lines.join('\n');
}
