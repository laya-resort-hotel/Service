# LAYA Hotel Portal

หน้าแรกของเว็บสำหรับแขกกรอกชื่อและเลขห้องเพื่อบันทึกเข้าระบบ ก่อนเข้าสู่บริการต่าง ๆ ของโรงแรม

## ไฟล์สำคัญ
- `index.html` หน้าแรก Guest Check-in
- `styles.css` สไตล์หน้าแรก
- `app.js` logic บันทึกข้อมูลและเปิดเมนู F&B
- `frontend/shared/firebase-config.js` ใส่ค่า Firebase จริง

## การเชื่อมระบบจริง
หน้าเว็บจะบันทึกลง Firestore collection ชื่อ `guest_checkins` เมื่อใส่ค่า Firebase ใน `frontend/shared/firebase-config.js`

ตัวอย่างข้อมูลที่บันทึก:
- `guestName`
- `roomNo`
- `consent`
- `source`
- `createdAt`

ถ้ายังไม่ใส่ค่า Firebase ระบบจะ fallback ไปเก็บใน localStorage ของเครื่องนี้เพื่อใช้ทดสอบหน้าจอ
