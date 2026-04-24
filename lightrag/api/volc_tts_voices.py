"""
Volcengine TTS voice metadata used by the speech API.
"""

from __future__ import annotations

from typing import Literal, TypedDict

VOLCENGINE_TTS_VOICE_SOURCE = "https://www.volcengine.com/docs/6561/1257544"

_RECOMMENDED_SPEAKER_IDS = {
    "zh_female_wenroushunv_uranus_bigtts",
    "zh_female_cancan_uranus_bigtts",
    "zh_female_vv_uranus_bigtts",
    "zh_female_gufengshaoyu_uranus_bigtts",
    "zh_female_xiaohe_uranus_bigtts",
}

_DEFAULT_CAPABILITIES = "情感变化、指令遵循、ASMR"

_VOICE_ROWS: tuple[tuple[str, str, str, str, str], ...] = (
    ("通用场景", "Vivi 2.0", "zh_female_vv_uranus_bigtts", "中文、日文、印尼、墨西哥西班牙语", ""),
    ("通用场景", "小何 2.0", "zh_female_xiaohe_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "云舟 2.0", "zh_male_m191_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "小天 2.0", "zh_male_taocheng_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "刘飞 2.0", "zh_male_liufei_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "魅力苏菲 2.0", "zh_female_sophie_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "清新女声 2.0", "zh_female_qingxinnvsheng_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "知性灿灿 2.0", "zh_female_cancan_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "撒娇学妹 2.0", "zh_female_sajiaoxuemei_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "甜美小源 2.0", "zh_female_tianmeixiaoyuan_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "甜美桃子 2.0", "zh_female_tianmeitaozi_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "爽快思思 2.0", "zh_female_shuangkuaisisi_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("视频配音", "佩奇猪 2.0", "zh_female_peiqi_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "邻家女孩 2.0", "zh_female_linjianvhai_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "少年梓辛/Brayan 2.0", "zh_male_shaonianzixin_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("视频配音", "猴哥 2.0", "zh_male_sunwukong_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("教育场景", "Tina老师 2.0", "zh_female_yingyujiaoxue_uranus_bigtts", "中文、英式英语", _DEFAULT_CAPABILITIES),
    ("客服场景", "暖阳女声 2.0", "zh_female_kefunvsheng_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("有声阅读", "儿童绘本 2.0", "zh_female_xiaoxue_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("视频配音", "大壹 2.0", "zh_male_dayi_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("视频配音", "黑猫侦探社咪仔 2.0", "zh_female_mizai_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("视频配音", "鸡汤女 2.0", "zh_female_jitangnv_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "魅力女友 2.0", "zh_female_meilinvyou_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("视频配音", "流畅女声 2.0", "zh_female_liuchangnv_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("视频配音", "儒雅逸辰 2.0", "zh_male_ruyayichen_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("多语种", "Tim", "en_male_tim_uranus_bigtts", "美式英语", _DEFAULT_CAPABILITIES),
    ("多语种", "Dacey", "en_female_dacey_uranus_bigtts", "美式英语", _DEFAULT_CAPABILITIES),
    ("多语种", "Stokie", "en_female_stokie_uranus_bigtts", "美式英语", _DEFAULT_CAPABILITIES),
    ("通用场景", "温柔妈妈 2.0", "zh_female_wenroumama_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "解说小明 2.0", "zh_male_jieshuoxiaoming_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "TVB女声 2.0", "zh_female_tvbnv_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "译制片男 2.0", "zh_male_yizhipiannan_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "俏皮女声 2.0", "zh_female_qiaopinv_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "直率英子 2.0", "zh_female_zhishuaiyingzi_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "邻家男孩 2.0", "zh_male_linjiananhai_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "四郎 2.0", "zh_male_silang_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "儒雅青年 2.0", "zh_male_ruyaqingnian_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "擎苍 2.0", "zh_male_qingcang_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "熊二 2.0", "zh_male_xionger_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "樱桃丸子 2.0", "zh_female_yingtaowanzi_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "温暖阿虎/Alvin 2.0", "zh_male_wennuanahu_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "奶气萌娃 2.0", "zh_male_naiqimengwa_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "婆婆 2.0", "zh_female_popo_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "高冷御姐 2.0", "zh_female_gaolengyujie_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "傲娇霸总 2.0", "zh_male_aojiaobazong_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "懒音绵宝 2.0", "zh_male_lanyinmianbao_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "反卷青年 2.0", "zh_male_fanjuanqingnian_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "温柔淑女 2.0", "zh_female_wenroushunv_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "古风少御 2.0", "zh_female_gufengshaoyu_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "活力小哥 2.0", "zh_male_huolixiaoge_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("有声阅读", "霸气青叔 2.0", "zh_male_baqiqingshu_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("有声阅读", "悬疑解说 2.0", "zh_male_xuanyijieshuo_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "萌丫头/Cutey 2.0", "zh_female_mengyatou_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "贴心女声/Candy 2.0", "zh_female_tiexinnvsheng_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "鸡汤妹妹/Hope 2.0", "zh_female_jitangmei_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "磁性解说男声/Morgan 2.0", "zh_male_cixingjieshuonan_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "亮嗓萌仔 2.0", "zh_male_liangsangmengzai_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "开朗姐姐 2.0", "zh_female_kailangjiejie_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "高冷沉稳 2.0", "zh_male_gaolengchenwen_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "深夜播客 2.0", "zh_male_shenyeboke_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "鲁班七号 2.0", "zh_male_lubanqihao_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "娇喘女声 2.0", "zh_female_jiaochuannv_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "林潇 2.0", "zh_female_linxiao_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "玲玲姐姐 2.0", "zh_female_lingling_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "春日部姐姐 2.0", "zh_female_chunribu_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "唐僧 2.0", "zh_male_tangseng_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "庄周 2.0", "zh_male_zhuangzhou_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "开朗弟弟 2.0", "zh_male_kailangdidi_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "猪八戒 2.0", "zh_male_zhubajie_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "感冒电音姐姐 2.0", "zh_female_ganmaodianyin_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "谄媚女声 2.0", "zh_female_chanmeinv_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "女雷神 2.0", "zh_female_nvleishen_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "亲切女声 2.0", "zh_female_qinqienv_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "快乐小东 2.0", "zh_male_kuailexiaodong_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "开朗学长 2.0", "zh_male_kailangxuezhang_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "悠悠君子 2.0", "zh_male_youyoujunzi_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "文静毛毛 2.0", "zh_female_wenjingmaomao_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "知性女声 2.0", "zh_female_zhixingnv_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "清爽男大 2.0", "zh_male_qingshuangnanda_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "渊博小叔 2.0", "zh_male_yuanboxiaoshu_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "阳光青年 2.0", "zh_male_yangguangqingnian_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "清澈梓梓 2.0", "zh_female_qingchezizi_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "甜美悦悦 2.0", "zh_female_tianmeiyueyue_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "心灵鸡汤 2.0", "zh_female_xinlingjitang_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "温柔小哥 2.0", "zh_male_wenrouxiaoge_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "柔美女友 2.0", "zh_female_roumeinvyou_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "东方浩然 2.0", "zh_male_dongfanghaoran_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "温柔小雅 2.0", "zh_female_wenrouxiaoya_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "天才童声 2.0", "zh_male_tiancaitongsheng_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "武则天 2.0", "zh_female_wuzetian_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("角色扮演", "顾姐 2.0", "zh_female_gujie_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("通用场景", "广告解说 2.0", "zh_male_guanggaojieshuo_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
    ("有声阅读", "少儿故事 2.0", "zh_female_shaoergushi_uranus_bigtts", "中文", _DEFAULT_CAPABILITIES),
)


VoiceGender = Literal["female", "male", "unknown"]


class VolcengineTTSVoice(TypedDict):
    category: str
    name: str
    speaker_id: str
    language: str
    gender: VoiceGender
    recommended: bool


def _infer_gender(speaker_id: str) -> VoiceGender:
    if "_female_" in speaker_id or speaker_id.startswith("en_female"):
        return "female"
    if "_male_" in speaker_id or speaker_id.startswith("en_male"):
        return "male"
    return "unknown"


VOLCENGINE_TTS_VOICES: tuple[VolcengineTTSVoice, ...] = tuple(
    {
        "category": category,
        "name": name,
        "speaker_id": speaker_id,
        "language": language,
        "gender": _infer_gender(speaker_id),
        "recommended": speaker_id in _RECOMMENDED_SPEAKER_IDS,
    }
    for category, name, speaker_id, language, _capabilities in _VOICE_ROWS
)
