require("dotenv").config();
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const connectDB = require("../config/database");
const User = require("../models/user");

const DEFAULT_PASSWORD = "Public@123";

const avatarUrl = (name) =>
  `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&size=256&background=random`;

const publicFigures = [
  {
    firstName: "Elon",
    lastName: "Musk",
    emailId: "elon.musk@example.com",
    age: 53,
    gender: "male",
    about: "Entrepreneur building rockets, cars, and neural interfaces.",
    skills: ["Engineering", "Rockets", "AI", "Entrepreneurship"],
  },
  {
    firstName: "Narendra",
    lastName: "Modi",
    emailId: "narendra.modi@example.com",
    age: 74,
    gender: "male",
    about: "Public servant focused on nation building and governance.",
    skills: ["Leadership", "Public Speaking", "Policy"],
  },
  {
    firstName: "Virat",
    lastName: "Kohli",
    emailId: "virat.kohli@example.com",
    age: 36,
    gender: "male",
    about: "Cricketer chasing excellence, one run at a time.",
    skills: ["Cricket", "Fitness", "Leadership"],
  },
  {
    firstName: "Cristiano",
    lastName: "Ronaldo",
    emailId: "cristiano.ronaldo@example.com",
    age: 39,
    gender: "male",
    about: "Footballer obsessed with goals and discipline.",
    skills: ["Football", "Fitness", "Discipline"],
  },
  {
    firstName: "Barack",
    lastName: "Obama",
    emailId: "barack.obama@example.com",
    age: 64,
    gender: "male",
    about: "Former statesman passionate about community and change.",
    skills: ["Leadership", "Writing", "Public Speaking"],
  },
  {
    firstName: "Taylor",
    lastName: "Swift",
    emailId: "taylor.swift@example.com",
    age: 35,
    gender: "female",
    about: "Singer-songwriter who turns life into lyrics.",
    skills: ["Songwriting", "Singing", "Guitar"],
  },
  {
    firstName: "Bill",
    lastName: "Gates",
    emailId: "bill.gates@example.com",
    age: 69,
    gender: "male",
    about: "Tech pioneer turned philanthropist solving global problems.",
    skills: ["Software", "Philanthropy", "Strategy"],
  },
  {
    firstName: "Serena",
    lastName: "Williams",
    emailId: "serena.williams@example.com",
    age: 43,
    gender: "female",
    about: "Tennis champion and advocate for equality in sports.",
    skills: ["Tennis", "Fitness", "Entrepreneurship"],
  },
  {
    firstName: "Lionel",
    lastName: "Messi",
    emailId: "lionel.messi@example.com",
    age: 37,
    gender: "male",
    about: "Footballer who lets the ball do the talking.",
    skills: ["Football", "Dribbling", "Teamwork"],
  },
  {
    firstName: "Oprah",
    lastName: "Winfrey",
    emailId: "oprah.winfrey@example.com",
    age: 70,
    gender: "female",
    about: "Media icon inspiring millions through storytelling.",
    skills: ["Media", "Public Speaking", "Philanthropy"],
  },
];

const seedUsers = async () => {
  await connectDB();
  console.log("Connected to DB, seeding users...");

  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);

  for (const figure of publicFigures) {
    const existing = await User.findOne({ emailId: figure.emailId });
    if (existing) {
      console.log(`Skipping ${figure.emailId} (already exists)`);
      continue;
    }

    const user = new User({
      ...figure,
      password: passwordHash,
      photoUrl: avatarUrl(`${figure.firstName} ${figure.lastName}`),
    });

    await user.save();
    console.log(`Created ${figure.firstName} ${figure.lastName}`);
  }

  console.log(`\nDone. All seeded users share the password: ${DEFAULT_PASSWORD}`);
  await mongoose.connection.close();
};

seedUsers().catch((err) => {
  console.error("Seeding failed:", err.message);
  process.exit(1);
});
