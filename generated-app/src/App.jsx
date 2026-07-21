import React, { useState } from 'react';
import './App.css';

const FeedbackForm = () => {
    const [email, setEmail] = useState('');
    const [rating, setRating] = useState(0);
    const [comment, setComment] = useState('');
    const [emailError, setEmailError] = useState('');

    const validateEmail = (email) => {
        const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return regex.test(email);
    };

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!validateEmail(email)) {
            setEmailError('Please enter a valid email address.');
            return;
        }
        // Submit form logic
    };

    return (
        <div className="container">
            <h1>Feedback for Modern Feedback Co.</h1>
            <form onSubmit={handleSubmit}>
                <div className="form-group">
                    <label htmlFor="email">Email:</label>
                    <input
                        type="email"
                        id="email"
                        value={email}
                        onChange={(e) => { setEmail(e.target.value); setEmailError(''); }}
                        required
                    />
                    {emailError && <div style={{ color: 'red' }}>{emailError}</div>}
                </div>
                <div className="form-group">
                    <label>Ratings:</label>
                    <div className="star-rating">
                        {[1, 2, 3, 4, 5].map((star) => (
                            <span
                                key={star}
                                className="star"
                                onClick={() => setRating(star)}>
                                {rating >= star ? '★' : '☆'}
                            </span>
                        ))}
                    </div>
                </div>
                <div className="form-group">
                    <label htmlFor="comment">Comment:</label>
                    <textarea
                        id="comment"
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        rows="4"
                        required
                    ></textarea>
                </div>
                <button type="submit" className="button">Submit Feedback</button>
            </form>
        </div>
    );
};

export default FeedbackForm;