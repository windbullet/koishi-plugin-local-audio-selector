import { Context, Schema, Logger, h, noop } from 'koishi'
import fs from 'fs'
import path from 'path'
import filetype from 'file-type';

export const name = 'local-audio-selector'

export const usage = `
点歌.搜索 <文本>   
> 在配置项中指定的文件夹搜索

点歌.上传 <链接> [文件名]  
> 链接必须为音频文件的直链，不传入文件名时将用当前的时间戳作为文件名  
> 文件下载至配置项中指定的文件夹  
`

export interface Config {
  path: string
  allowUpload: boolean
  whitelist?: string[]
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    path: Schema.path({
      allowCreate: true,
      filters: ['directory']
    })
      .description("音频文件所在的文件夹路径")
      .required(),
  }),
  Schema.intersect([
    Schema.object({
      allowUpload: Schema.boolean().default(false)
      .description("是否允许用户上传音频文件")
      .default(false)
    }),
    Schema.union([
      Schema.object({
        allowUpload: Schema.const(true).required(),
        whitelist: Schema.array(Schema.string()).description("允许上传音频的用户，一个项目填一个ID。不填则所有人都能上传")
      }),
      Schema.object({
        allowUpload: Schema.const(false),
      })
    ])
  ])
  
])

export function apply(ctx: Context, config: Config) {
  ctx.command("点歌")

  ctx.command("点歌.搜索 <str:text>", {checkArgCount: true})
    .example("点歌.搜索 OTHERWORLDLY")
    .action(async ({ session }, str) => {
      let logger = new Logger("local-audio-selector")
      let result = []
      let files = await fs.promises.readdir(config.path)
      let num = 1
      for (let file of files) {
        let fileName = file.slice(0, file.lastIndexOf('.'))
        if (new RegExp(str).test(fileName)) {
          result.push(file)
        }
      }
      result.sort((a, b) => a.slice(0, a.lastIndexOf('.')).length - b.slice(0, b.lastIndexOf('.')).length)
      let resultStr = "搜索结果：\n"
      for (let file of result) {
        resultStr += `${num++}. ${file.slice(0, file.lastIndexOf('.'))}\n`
      }
      if (resultStr === "搜索结果：\n") return "没有找到"
      resultStr += "\n在30秒内发送序号以播放，发送取消以取消播放"
      await session.send(resultStr)
      let inputNum = await session.prompt(30000)
      if (inputNum === undefined) {
        noop()
      } else if (inputNum === "取消") {
        return "已取消播放"
      } else if (isNaN(+inputNum) || +inputNum < 1 || +inputNum > result.length) {
        return "无效的序号"
      } else {
        let fullPath = path.join(config.path, result[+inputNum - 1])
        let id = await session.send("正在发送...")
        try {
          await session.send(h.audio(`file:///${fullPath}`))
          session.bot.deleteMessage(session.event.channel.id, id[0])
        } catch (err) {
          logger.warn("发送失败 " + err.stack)
          return "发送失败，请查看日志"
        }
      }
    })
  
  ctx.command("点歌.上传 <link:string> [name:text]", {checkArgCount: true})
    .usage("链接必须为直链，不传入name将用当前的时间戳作为文件名")
    .example("点歌.上传 https://music.koishi.koi/koishi.mp3 koishi歌")
    .action(async ({ session }, link, name) => {
      if (!config.allowUpload) return "上传功能已关闭"
      if (config.whitelist.length === 0 || config.whitelist.includes(session.event.user.id)) {
        try {
          let request = await ctx.http.get(link, { responseType: "stream" });
          let type = await filetype.fromStream(request)
          if (!type.mime.startsWith("audio")) return "文件类型错误，请确保链接为音频文件"
          let fullPath = path.join(config.path, `${name ?? Date.now()}.${type.ext}`)
          let file = fs.createWriteStream(fullPath);
          request.pipe(file);
          return "上传成功"
        } catch (err) {
          let logger = new Logger("local-audio-selector")
          logger.warn("文件获取失败 " + err.stack)
          return "上传失败，请查看日志"
        }
      }
      return "你没有上传权限"
    })
}