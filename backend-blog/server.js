import express from 'express';
import mongoose from 'mongoose';
import 'dotenv/config';
import bcrypt from 'bcrypt';
import { nanoid } from 'nanoid';
import { dbConnection } from "./db.controller.js";

import { logger } from "./utils/logger.util.js";
//import jwt, { verify } from 'jsonwebtoken';
import User from './Schema/User.js';
import Blog from './Schema/Blog.js'
import cors from 'cors';
import admin from 'firebase-admin';
import serviceAccountKey from "./hustle-blog-auth-firebase-adminsdk-jz3zg-0f0f5f85b3.json" assert { type: "json" }
import { getAuth } from 'firebase-admin/auth';
import aws from "aws-sdk";
import jwt from 'jsonwebtoken';
import Notification from './Schema/Notification.js';
import Comment from "./Schema/Comment.js"

import https from "https";
import fs from "fs";

const server = express();
const PORT = 3016;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccountKey),
});
const privateKey = fs.readFileSync('/etc/letsencrypt/live/job4jobless.in/privkey.pem', 'utf8');
const certificate = fs.readFileSync('/etc/letsencrypt/live/job4jobless.in/fullchain.pem', 'utf8');
const credentials = {
  key: privateKey,
  cert: certificate,
};
const httpsServer = https.createServer(credentials, server);
// Create an HTTPS server using Express app and SSL credentia
httpsServer.listen(PORT, () => {
  console.log(`Server started at port ${PORT}`);
  dbConnection(process.env.DB_LOCATION);
});

const corsOptions = {
  origin: ['https://hustleforwork.com', 'http://localhost:4200', 'https://job4jobless.com'],
  optionsSuccessStatus: 200 // some legacy browsers (IE11, various SmartTVs) choke on 204
};
server.use(cors(corsOptions));
const emailRegex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/; // regex for email
const passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{6,20}$/; // regex for password

server.use(express.json());

mongoose.connect(process.env.DB_LOCATION, {
  autoIndex: true,
});

// Setting up the S3 Bucket
const s3 = new aws.S3({
  region: 'ap-south-1',
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY

})

const generateUploadURL = async () => {
  const date = new Date();
  const imageName = `${nanoid()}-${date.getTime()}.jpeg`;

  return await s3.getSignedUrlPromise('putObject', {Bucket: 'blog-job4jobless',
  Key: imageName,
  Expires: 1000,
  ContentType: "image/jpeg"
 
})
}

const verifyJWT = (req, res, next) => {

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(" ")[1];

  if(token == null){
    return res.status(401).json({ error : "No access token" });
  }

  jwt.verify(token, process.env.SECRET_ACCESS_KEY, (err, user) => {
    if(err){
      return res.status(403).json({ error: "Access token is invalid" });
    }

    req.user = user.id;
    next();
  });
};

const formatDatatoSend = (user) => {
  const access_token = jwt.sign({ id: user._id }, process.env.SECRET_ACCESS_KEY);
  return {
    access_token,
    profile_img: user.personal_info.profile_img,
    username: user.personal_info.username,
    fullname: user.personal_info.fullname,
  };
};

const generateUsername = async (email) => {
  let username = email.split('@')[0];

  const isUsernameNotUnique = await User.exists({ 'personal_info.username': username }).then((result) => result);

  if (isUsernameNotUnique) {
    username += nanoid().substring(0, 5);
  }

  return username;
};

//uploading image URL route
server.get('/get-upload-url', (req, res) => {
  generateUploadURL().then(url => res.status(200).json({ uploadURL: url }))
  .catch(err => {
    console.log(err.message);
    return res.status(500).json({ error: err.message })
  })
})

const db = mongoose.connection;
db.on('error', (error) => {
  console.error('Error connecting to database:', error);
});
db.once('open', () => {
  console.log('Connected to database');
});  
server.post('/signup', (req, res) => {
  const { fullname, email, password } = req.body;

  // validating the data

  if (fullname.length < 3) {
    return res.status(403).json({ error: 'Please enter your complete name' });
  }

  if (!email.length) {
    return res.status(403).json({ error: 'Enter your valid email Id' });
  }

  if (!emailRegex.test(email)) {
    return res.status(403).json({ error: 'Email is invalid' });
  }

  if (!passwordRegex.test(password)) {
    return res.status(403).json({
      error: 'Please enter a valid password. It must contain at least one digit, one lowercase letter, one uppercase letter, and be at least 8 characters long.',
    });
  }

  bcrypt.hash(password, 10, async (err, hashed_password) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    const username = await generateUsername(email);
    const user = new User({
      personal_info: { fullname, email, password: hashed_password, username },
    });

    user.save()
      .then((u) => res.status(200).json(formatDatatoSend(u)))
      .catch((err) => {
        if (err.code === 11000) {
          return res.status(500).json({ error: 'Email already exists' });
        }
        return res.status(500).json({ error: err.message });
      });
  });
});

server.post('/signin', (req, res) => {
  const { email, password } = req.body;

  User.findOne({ 'personal_info.email': email })
    .then((user) => {
      if (!user) {
        return res.status(403).json({ error: 'No such email found!' });
      }


      if(!user.google_auth){

        bcrypt.compare(password, user.personal_info.password, (err, result) => {
          if (err) {
            return res.status(403).json({ error: 'Something went wrong' });
          }
 
          if (!result) {
            return res.status(403).json({ error: 'Password is incorrect' });
          }
          return res.status(200).json(formatDatatoSend(user));
        })


      } else{
        return res.status(403).json({ "error": "Account already registered. Kindly login with Google "})
      }

    })
    .catch((err) => res.status(500).json({ error: err.message }));
});

server.post('/google-auth', async (req, res) => {
  const { access_token } = req.body;

  try {
    const decodedUser = await admin.auth().verifyIdToken(access_token);
    const { email, name, picture } = decodedUser;

    const modifiedPicture = picture.replace('s96-c', 's384-c');

    let user = await User.findOne({ 'personal_info.email': email })
      .select('personal_info.fullname personal_info.username personal_info.profile_img google_auth')
      .then((u) => u || null)
      .catch((err) => {
        throw new Error(err.message);
      });

    if (user) {
      if (!user.google_auth) {
        return res.status(403).json({ error: 'Something went wrong, kindly enter email and password' });
      }
    } else {
      const username = await generateUsername(email);
      user = new User({
        personal_info: { fullname: name, email, password: '', username },
        google_auth: true,
      });
      await user.save();
    }

    return res.status(200).json(formatDatatoSend(user));
  } catch (error) {
    console.error('Error verifying ID token:', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
});

server.post('/latest-blogs', (req, res) => {
  let { page } = req.body;
  let maxLimit = 5;
  Blog.find({ draft: false }) // Filter blogs where draft is false and approved is true
    .populate("author", "personal_info.profile_img personal_info.username personal_info.fullname -_id")
    .sort({ "publishedAt": -1 })
    .select("blog_id _id title des banner activity approved tags publishedAt")
    .skip((page - 1) * maxLimit)
    .limit(maxLimit)
    .then(blogs => {
      return res.status(200).json({ blogs });
    })
    .catch(err => {
      return res.status(500).json({ error: err.message });
    });
});

server.post('/latest-blogs-approved', (req, res) => {
  let { page } = req.body;
  let maxLimit = 5;
  Blog.find({ draft: false, approved: true }) // Filter blogs where draft is false and approved is true
    .populate("author", "personal_info.profile_img personal_info.username personal_info.fullname -_id")
    .sort({ "publishedAt": -1 })
    .select("blog_id _id title des banner activity approved tags publishedAt")
    .skip((page - 1) * maxLimit)
    .limit(maxLimit)
    .then(blogs => {
      return res.status(200).json({ blogs });
    })
    .catch(err => {
      return res.status(500).json({ error: err.message });
    });
});


server.post("/all-latest-blogs-count", (req, res) => {
  Blog.countDocuments({ draft: false })
  .then(count => {
    return res.status(200).json({ totalDocs: count })
  })
  .catch(err => {
    console.log(err.message);
    return res.status(500).json({ error: err.message})
  })
})

server.get("/trending-blogs", (req, res) => {

  Blog.find({ draft: false})
  .populate("author", "personal_info.profile_img personal_info.username personal_info.fullname -_id")
  .sort({ "activity.total_read": -1, "activity.total_likes":-1, "publishedAt": -1})
  .select("blog_id title publishedAt -_id")
  .limit(8)
  .then(blogs => {
    return res.status(200).json({ blogs })
 })
 .catch(err => {
  return res.status(500).json({ error: err.message })
 })
})

// server.post("/search-blogs", (req, res) => {
//   let { tag, query, page } = req.body;

//   let findQuery;

//   if(tag){
//     findQuery = { tags: tag, draft: false };
//   } else if(query){
//     findQuery = { draft: false, title: new RegExp(query, 'i')}
//   }
// })

server.post("/search-blogs", (req, res) => {
  let { tag, query, author, page, limit, eliminate_blog } = req.body;

  let findQuery;

  if(tag){
    findQuery = { tags: tag, draft: false, blog_id: { $ne: eliminate_blog } };
  } else if(query){
    findQuery = { draft: false, title: new RegExp(query, 'i')}
  } else if(author){
    findQuery = { author, draft: false }
  }


  let maxLimit= limit ? limit : 2;
  Blog.find(findQuery)
  .populate("author", "personal_info.profile_img personal_info.username personal_info.fullname -_id")
  .sort({ "publishedAt": -1})
  .select("blog_id title des banner activity tags publishedAt -_id")
  .skip((page - 1) * maxLimit)
  .limit(maxLimit)
  .then(blogs => {
    return res.status(200).json({ blogs })
 })
 .catch(err => {
  return res.status(500).json({ error: err.message })
 })
})

// server.post("/search-blogs", (req, res) => {
//   let { tag, page } = req.body;
//   let findQuery = { tags: tag, draft: false };

//   let maxLimit= 3;
//   Blog.find(findQuery)
//   .populate("author", "personal_info.profile_img personal_info.username personal_info.fullname -_id")
//   .sort({ "publishedAt": -1})
//   .select("blog_id title des banner activity tags publishedAt -_id")
//   .skip((page - 1) * maxLimit)
//   .limit(maxLimit)
//   .then(blogs => {
//     return res.status(200).json({ blogs })
//  })
//  .catch(err => {
//   return res.status(500).json({ error: err.message })
//  })
// })

server.post("/search-blogs-count", (req, res) => {
  let { tag, author, query } = req.body;

  let findQuery;

  if (tag) {
    findQuery = { tags: tag, draft: false };
  } else if (query) {
    // Escape special characters in the query string
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    findQuery = { draft: false, title: new RegExp(escapedQuery, 'i') };
  } else if (author) {
    findQuery = { author, draft: false };
  }

  Blog.countDocuments(findQuery)
    .then(count => {
      return res.status(200).json({ totalDocs: count });
    })
    .catch(err => {
      console.log(err.message);
      return res.status(500).json({ error: err.message });
    });
});


server.post("/search-users", (req, res) => {
  let { query } = req.body;

  User.find({ "personal_info.username": new RegExp(query, 'i') })
    .limit(50)
    .select("personal_info.fullname personal_info.username personal_info.profile_img")
    .then(users => {
      return res.status(200).json({ users })
    })
    .catch(err => {
      return res.status(500).json({ error: err.message })
    })
})

// server.post("/get-profile", (req, res) => {
//   let { username } = req.body;

//   User.findOne({ "personal_info.username": username })
//   .select("-personal_info.password -google_auth -updatedAt -blogs")
//   .then(user => {
//     return res.status(200).json(user)
//   })
//   .catch(err => {
//     console.log(err);
//     return res.status(500).json({ error: err.message })
//   })
// })

server.post("/get-profile", async (req, res) => {
  try {
    const { username } = req.body;

    // Find the user by username, excluding sensitive fields
    const user = await User.findOne({ "personal_info.username": username })
      .select("-personal_info.password -google_auth -updatedAt -blogs");

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Return the user's profile
    return res.status(200).json(user);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});




server.post('/create-blog', verifyJWT, (req, res) => {
  let authorId = req.user;

  let { title, des, banner, tags, content, draft, id } = req.body;
 
  if (!title.length) {
    return res.status(403).json({ error: "Kindly provide the title as well" });
  }

  if(!draft){

 
    if (!des.length) {
      return res.status(403).json({ error: "Kindly provide the blog description as well" });
    }
 
    if (!banner.length) {
      return res.status(403).json({ error: "Kindly upload the suitable banner as well" });
    }
 
    if (!content.length) {
      return res.status(403).json({ error: "Content can't be empty" });
    }
 
    if (!tags.length || tags.length > 10) {
      return res.status(403).json({ error: "Provide the tags as well for better reach" });
    }

  }



  tags = tags.map(tag => tag.toLowerCase());

  let blog_id = id || title.replace(/[^a-zA-Z0-9]/g, ' ').replace(/\s+/g, "-").trim() + nanoid();

  if(id){

    Blog.findOneAndUpdate({ blog_id }, { title, des, banner, content, tags, draft: draft ? draft : false })
    .then(blog => {
      return res.status(200).json({ id: blog_id });
    })
    .catch(err => {
      return res.status(500).json({ error: err.message})
    })

  }else{
    let blog = new Blog({
      title, des, banner, content, tags, author: authorId, blog_id, draft: Boolean(draft)
    })
 
    blog.save().then(blog => {
 
      let incrementVal = draft ? 0 : 1;
      User.findOneAndUpdate({ _id: authorId }, { $inc : { "account_info.total_posts" : incrementVal }, $push : { "blogs": blog._id } })
      .then(user => {
        return res.status(200).json({ id: blog.blog_id })
      })
      .catch(err => {
        return res.status(500).json({ error: " Something went wrong while updating the total post numbers "})
      })
    })
    .catch(err => {
 
      return res.status(500).json({ error: err.message });
    })

  }



 
});

server.post("/get-blog", (req, res) => {

  let { blog_id, draft, mode } = req.body;

  let incrementVal = mode != 'edit' ? 1 : 0;

  Blog.findOneAndUpdate({ blog_id }, { $inc : { "activity.total_reads": incrementVal} })
  .populate("author", "personal_info.fullname personal_info.username personal_info.profile_img")
  .select("title des content banner activity publishedAt blog_id tags")
  .then(blog => {

    User.findOneAndUpdate({ "personal_info.username": blog.author.personal_info.username }, {
      $inc : { "account_info.total_reads": incrementVal }
    })
    .catch(err => {
      return res.status(500).json({ error: err.message })
    })

    if(blog.draft && !draft){
      return res.status(500).json({ error : 'Draft blogs are not accessible'})
   
    }
    return res.status(200).json({ blog });
  })

  .catch(err => {
    return res.status(500).json({ error: err.message });  
  })
})


server.post("/like-blog", verifyJWT, (req, res) => {
  let user_id = req.user;

  let { _id, isLikedByUser } = req.body;
  let incrementVal = !isLikedByUser ? 1 : -1;
  Blog.findOneAndUpdate({ _id}, { $inc: { "activity.total_likes": incrementVal } })
  .then(blog => {
    if(!isLikedByUser){
      let like = new Notification({
        type: "like",
        blog: _id,
        notification_for: blog.author,
        user: user_id
      })

      like.save().then(notification => {
        return res.status(200).json({ liked_by_user: true })
      })

    }

    else{
      Notification.findOneAndDelete({ user: user_id, blog: _id, type: "like" })
      .then(data => {
        return res.status(200).json({ liked_by_user: false })
      })
      .catch(err => {
        return res.status(500).json({ error: err.message });
      })
    }
  })
})


server.post("/isliked-by-user", verifyJWT, (req, res) => {
  let user_id = req.user;
  let { _id } = req.body;

  Notification.findOne({ user: user_id, type: "like", blog: _id })
    .populate("user", "personal_info.username") // Assuming user is the reference to the User model
    .then((notification) => {
      if (notification) {
        return res.status(200).json({ result: true, user_id: notification.user._id });
      } else {
        return res.status(200).json({ result: false });
      }
    })
    .catch((err) => {
      return res.status(500).json({ error: err.message });
    });
});

server.post("/add-comment", verifyJWT, (req, res) => {
  let user_id = req.user;
  let { _id, comment, blog_author, replying_to } = req.body;
//to be resumed
  if(!comment.length){
    return res.status(403).json({ error: "Kindly enter your comment" });
  }

  let commentObj = {
    blog_id: _id, blog_author, comment, commented_by: user_id,
  }

  if(replying_to){
    commentObj.parent = replying_to;
  }

  new Comment(commentObj).save().then(async commentFile => {

    let { comment, commentedAt, children } = commentFile;
    Blog.findOneAndUpdate({ _id}, { $push: { "comments": commentFile._id}, $inc : { "activity.total_comments": 1, "activity.total_parent_comments": replying_to ? 0 : 1 }, })
    .then(blog => { console.log('Commented')});

    let notificationObj = {
      type: replying_to ? "reply" : "comment",
      blog: _id,
      notification_for: blog_author,
      user: user_id,
      comment: commentFile._id
    }

    if(replying_to){
      notificationObj.replied_on_comment = replying_to;

      await Comment.findOneAndUpdate({ _id: replying_to }, { $push: { children: commentFile._id } })
      .then(replyingToCommentDoc => { notificationObj.notification_for = replyingToCommentDoc.commented_by })

     
    }

    new Notification(notificationObj).save().then(notification => console.log('new notification appeared'));

    return res.status(200).json({
      comment, commentedAt, _id: commentFile._id, user_id, children
    })

  })


})

server.post("/get-blog-comments", (req, res) => {
  let { blog_id, skip } = req.body;
  let maxLimit = 5;

  Comment.find({ blog_id, isReply: false })
  .populate("commented_by", "personal_info.username personal_info.fullname personal_info.profile_img")
  .skip(skip)
  .limit(maxLimit)
  .sort({
    'commenntedAt': -1
  })
  .then(comment => {
    return res.status(200).json(comment);
  })
  .catch(err => {
    console.log(err.message);
    return res.status(500).json({ error: err.message })
  })
})


server.put('/toggle-approval/:blog_id', async (req, res) => {
  const { blog_id } = req.params;
  try {
    const blog = await Blog.findById(blog_id);
    if (!blog) {
      return res.status(404).json({ message: 'Blog not found' });
    }

    // Toggle the approved value
    blog.approved = !blog.approved;
    await blog.save();

    res.status(200).json({ message: 'Blog approval status toggled', blog });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to toggle blog approval status', error });
  }
});


server.post('/upload-image', async (req, res) => {
try {
//   Call generateUploadURL function to get the image upload URL
    const uploadURL = await generateUploadURL();
console.log("checking the image",uploadURL);
    res.status(200).json({ uploadURL });
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }

//
//server.post('/upload-image', async (req, res) => {
//try {
 // const { imageName } = req.body; // Assuming you pass imageName in the request body

    //const params = {
      //Bucket: 'hustle-for-work-blog',
      //Key: imageName, // File name to be stored in the bucket
      //Expires: 3600, // URL expiration time in seconds (1 hour)
      //ContentType: 'image/jpeg' // MIME type of the image
    //};

  //  const uploadURL = await s3.getSignedUrlPromise('putObject', params);
//console.log("checking the image",uploadURL);
   // res.status(200).json({ uploadURL });
  //} catch (error) {
    //console.error('Error uploading image:', error);
   //res.status(500).json({ error: 'Failed to upload image' });
  //}
});


server.post('/reset-password', async (req, res) => {
    const { email, newPassword } = req.body;

    try {
        // Check if email exists in the database
        const user = await User.findOne({ 'personal_info.email': email });
        if (!user) {
            return res.status(404).json({ error: 'Email not found' });
        }

        // Hash the new password
        bcrypt.hash(newPassword, 10, async (err, hashedPassword) => {
            if (err) {
                return res.status(500).json({ error: 'Error hashing password' });
            }

            // Update the user's password in the database
            user.personal_info.password = hashedPassword;
            await user.save();

            return res.status(200).json({ message: 'Password reset successful' });
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});



//server.listen(PORT, () => {
  //console.log('Listening on Port -> ' + PORT);
// console.log('checking the server is porperly working ');
//});
