import { Context, Schema, Logger, h, noop } from 'koishi'
import fs from 'fs'
import path from 'path'
import filetype from 'file-type';
import {} from 'koishi-plugin-silk'
import {} from 'koishi-plugin-ffmpeg'
import { promisify } from "util";
import stream from "stream";

export const name = 'local-audio-selector'

export const inject = {
  optional: ['silk', 'ffmpeg']
}

export const usage = `
官方QQ机器人需要在插件市场安装silk和ffmpeg插件才能正常使用  

点歌.搜索 <文本>   
> 在配置项中指定的文件夹搜索

点歌.上传 <链接> [文件名]  
> 链接必须为音频文件的直链，不传入文件名时将用上传者用户名和当前的时间戳作为文件名 
> 文件下载至配置项中指定的文件夹  
`

export interface Config {
  path: string
  allowUpload: boolean
  whitelist?: string[]
  maxFileSize?: number
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
        maxFileSize: Schema.number()
          .description("允许上传的最大文件大小(KB)，不填则不限制"),
        whitelist: Schema.array(Schema.string()).description("允许上传音频的用户，一个项目填一个ID。不填则所有人都能上传")
      }),
      Schema.object({
        allowUpload: Schema.const(false),
      })
    ])
  ])
])

const pipeline = promisify(stream.pipeline);

export function apply(ctx: Context, config: Config) {
  ctx.command("点歌")

  ctx.command("点歌.搜索 <str:text>", {checkArgCount: true})
    .example("点歌.搜索 OTHERWORLDLY")
    .action(async ({ session }, str) => {
      let logger = new Logger("local-audio-selector")
      let result = []
      let files = fs.readdirSync(config.path)
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
          if (session.platform === "qq") {
            if (!ctx.silk) throw new Error("silk 服务未加载")
            if (!ctx.ffmpeg) throw new Error("ffmpeg 服务未加载")
            let buf = fs.readFileSync(fullPath)
            let data = await ctx.ffmpeg
              .builder()
              .input(buf)
              .outputOption("-ar", '24000', '-ac', '1', '-f', 's16le')
              .run('buffer')
            let res = await ctx.silk.encode(data, 24000)
            await session.send(h.audio(Buffer.from(res.data), "audio/amr"))
          } else {
            await session.send(h.audio(`file:///${fullPath}`))
          }
        } catch (err) {
          logger.warn("发送失败 " + err.stack)
          return "发送失败，请查看日志"
        }
        try {
          session.bot.deleteMessage(session.event.channel.id, id[0])
        } catch {
          noop()
        }
      }
    })
  

  ctx.command("点歌.上传 <link:string> [name:text]", {checkArgCount: true})
    .usage("链接必须为直链，不传入name将使用上传者用户名和当前的时间戳作为文件名")
    .example("点歌.上传 https://music.koishi.koi/koishi.mp3 koishi歌")
    .action(async ({ session }, link, name) => {
      if (!config.allowUpload) return "上传功能已关闭"
      if (config.whitelist.length === 0 || config.whitelist.includes(session.event.user.id)) {
        try {
          await session.send("正在上传...")

          let res = await ctx.http.head(link)
          if (res["content-length"] / 1000 > config.maxFileSize) return "文件大小超过限制"

          let controller = new AbortController()
          let signal = controller.signal
          let response = await ctx.http.get(link, { responseType: "stream", signal });
          try {
            let writer = await new Promise<any>(async resolve => {
              await response.once("data", async (chunk: Buffer) => {
                let type = await filetype.fromBuffer(chunk)
                if (!type.mime.startsWith("audio")) {
                  resolve(1)
                } else {
                  let fullPath = path.join(config.path, `${name ?? session.username + "-" + Date.now()}.${type.ext}`)
                  let exist = await fs.promises.access(fullPath, fs.constants.F_OK)
                    .then(() => true)
                    .catch(() => false)
                  if (exist) return resolve(2)
                  let writer = fs.createWriteStream(fullPath)
                  writer.write(chunk)
                  resolve(writer)
                }
              })
            })            
            if (writer === 2) {
              controller.abort()
              return "已存在同名文件"
            } else if (writer === 1) {
              controller.abort()
              return "文件类型错误，请确保链接为音频文件"
            }

            await pipeline(response, writer)

            return "上传成功"
          } catch (err) {
            let logger = new Logger("local-audio-selector")
            logger.warn("文件保存失败 " + err.stack)
            return "上传失败，请查看日志"
          }
        } catch (err) {
          let logger = new Logger("local-audio-selector")
          logger.warn("文件获取失败 " + err.stack)
          return "上传失败，请查看日志"
        }
      }

      return "你没有上传权限"
    })
}