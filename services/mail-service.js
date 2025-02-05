const nodemailer = require('nodemailer');
const smtpTransport = require('nodemailer-smtp-transport');

const fs = require('fs');
const email_confirm = fs.readFileSync('./emails/email-confirm.html', 'utf8');

const transporter = nodemailer.createTransport(
    smtpTransport({
        service: 'gmail',
        host: 'smtp.gmail.com',
        auth: {
            user: process.env.GMAIL_USERNAME,
            pass: process.env.GMAIL_PASSWORD,
        },
    })
);

exports.sendConfirmMail = async (user) => {
    const emailCode = this.generate(6);
    const queryString = `?userId=${user.id}&code=${emailCode}`;
    const generatedTemplate = email_confirm
        .replace('{{query_string}}', queryString)
        .replace('{{verify_url}}', process.env.VERIFY_URL);

    await this.sendMail(user.email, 'Please confirm your email!', generatedTemplate);

    user.emailCode = emailCode;
    await user.save();
};

exports.generate = (n) => {
    var add = 1,
        max = 12 - add;

    if (n > max) {
        return generate(max) + generate(n - max);
    }

    max = Math.pow(10, n + add);
    var min = max / 10;
    var number = Math.floor(Math.random() * (max - min + 1)) + min;

    return ('' + number).substring(add);
};

exports.sendMail = async (email, subject, template) => {
    try {
        let info = await transporter.sendMail({
            from: '"WALLFAIR" noreply@wallfair.io',
            to: email,
            subject: subject,
            html: template,
        });

        console.log('email sent: %s', info.messageId);
    } catch (err) {
        console.log(err);
        console.log('email sent failed to: %s', email);
    }
};
