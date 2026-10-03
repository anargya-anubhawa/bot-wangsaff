import axios from 'axios';


import config from '../../config.js';
const pluginConfig = {
    name: 'trivia',
    alias: [],
    category: 'game',
    description: 'Quiz pengetahuan umum',
    usage: '.trivia',
    example: '.trivia',
    isOwner: false,
    isPremium: false,
    isGroup: true,
    isPrivate: false,
    cooldown: 30,
    energi: 1,
    isEnabled: true
}

let activeGames = {}

async function getTrivia() {
    try {
        const res = await axios.get('https://opentdb.com/api.php?amount=1&type=multiple&encode=url3986')
        const data = res.data.results[0]
        
        return {
            question: decodeURIComponent(data.question),
            correct: decodeURIComponent(data.correct_answer),
            options: [
                decodeURIComponent(data.correct_answer),
                ...data.incorrect_answers.map(a => decodeURIComponent(a))
            ].sort(() => Math.random() - 0.5)
        }
    } catch {
        return null
    }
}

async function handler(m, { sock, db }) {
    const chatId = m.chat
    
    if (activeGames[chatId]) {
        return m.reply(`⏳ *ᴍᴀꜱɪʜ ᴀᴅᴀ ɢᴀᴍᴇ ʏᴀɴɢ ʙᴇʀʟᴀɴɢꜱᴜɴɢ!*`)
    }
    
    m.react('📚')
    await m.reply(`⏳ *ᴍᴇɴᴄᴀʀɪ ᴘᴇʀᴛᴀɴʏᴀᴀɴ...*`)
    
    const trivia = await getTrivia()
    if (!trivia) {
        return m.reply(`💔 *ɢᴀɢᴀʟ*\n\n> Gagal mengambil pertanyaan. Coba lagi yaa~`)
    }
    
    let optionsText = ''
    for (let i = 0; i < trivia.options.length; i++) {
        optionsText += `┃    ${i + 1}. ${trivia.options[i]}\n`
    }
    
    activeGames[chatId] = {
        jawaban: trivia.correct.toLowerCase(),
        time: setTimeout(() => {
            if (activeGames[chatId]) {
                m.reply(`⏰ *ᴡᴀᴋᴛᴜ ʜᴀʙɪꜱ!*\n\n> Jawabannya: *${trivia.correct}*`)
                delete activeGames[chatId]
            }
        }, 30000)
    }
    
    await m.reply(
        `📚 *ᴛʀɪᴠɪᴀ* 📚\n\n` +
        `╭━━━━━━━━━━━━━━━━━━━━━⬣\n` +
        `┃ 📝 *ᴘᴇʀᴛᴀɴʏᴀᴀɴ*:\n` +
        `┃ ${trivia.question}\n` +
        `┃\n` +
        `┃ 🔢 *ᴘɪʟɪʜᴀɴ*:\n` +
        `${optionsText}` +
        `┃\n` +
        `┃ ⏱️ *ᴡᴀᴋᴛᴜ*: 30 detik\n` +
        `┃ 💰 *ʜᴀᴅɪᴀʜ*: 40 limit\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━⬣\n\n` +
        `> Ketik *1, 2, 3, atau 4* untuk menjawab`
    )
}

async function answerHandler(m, { sock, db }) {
    const chatId = m.chat
    const game = activeGames[chatId]
    
    if (!game) return false
    
    const answerIndex = parseInt(m.text?.trim())
    if (isNaN(answerIndex) || answerIndex < 1 || answerIndex > 4) return false
    
    // Ini butuh nyimpen options, tapi simplified dulu
    // Untuk full version perlu nyimpen options juga
    
    return false
}

export { pluginConfig as config, handler, answerHandler };
